#import "RNCWebViewNativeProxy.h"

#import "RNCWebViewImpl.h"

static NSString *const RNCBridgeKind = @"__rnc_inappwebview_bridge__";
static NSUInteger const RNCProxyMaxResponseBytes = 25000000;

@implementation RNCWebViewNativeProxy

+ (BOOL)tryHandleMessage:(id)message
                 webView:(WKWebView *)webView
                   owner:(RNCWebViewImpl *)owner
            allowedHosts:(NSArray<NSString *> *)allowedHosts
{
  if (![message isKindOfClass:[NSString class]]) {
    return NO;
  }
  NSData *jsonData = [(NSString *)message dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *envelope = jsonData == nil
    ? nil
    : [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
  if (![envelope isKindOfClass:[NSDictionary class]] ||
      ![envelope[@"kind"] isEqual:RNCBridgeKind] ||
      ![envelope[@"type"] isEqual:@"handler-call"] ||
      ![envelope[@"handlerName"] isEqual:@"sendToApp"]) {
    return NO;
  }
  NSArray *args = envelope[@"args"];
  NSDictionary *command = [args isKindOfClass:[NSArray class]] && args.count > 0 &&
    [args[0] isKindOfClass:[NSDictionary class]] ? args[0] : nil;
  if (command == nil || ![command[@"cmd"] isEqual:@"proxy"]) {
    return NO;
  }
  NSNumber *callID = envelope[@"id"];
  if (![callID isKindOfClass:[NSNumber class]]) {
    return NO;
  }
  [self executeCommand:command
                callID:callID.integerValue
               webView:webView
                 owner:owner
          allowedHosts:allowedHosts];
  return YES;
}

+ (void)executeCommand:(NSDictionary *)command
                callID:(NSInteger)callID
               webView:(WKWebView *)webView
                 owner:(RNCWebViewImpl *)owner
          allowedHosts:(NSArray<NSString *> *)allowedHosts
{
  NSInteger requestID = [command[@"id"] respondsToSelector:@selector(integerValue)]
    ? [command[@"id"] integerValue] : -1;
  NSString *rawURL = [command[@"url"] isKindOfClass:[NSString class]] ? command[@"url"] : @"";
  NSString *method = [command[@"method"] isKindOfClass:[NSString class]]
    ? [command[@"method"] uppercaseString] : @"GET";
  NSSet<NSString *> *methods = [NSSet setWithArray:@[@"GET", @"HEAD", @"POST", @"PUT", @"PATCH", @"DELETE", @"OPTIONS"]];
  NSURLComponents *components = [NSURLComponents componentsWithString:rawURL];
  NSString *hostOverride = nil;
  NSString *encodedHeaders = nil;
  NSMutableArray<NSURLQueryItem *> *queryItems = [NSMutableArray array];
  for (NSURLQueryItem *item in components.queryItems ?: @[]) {
    if ([item.name isEqualToString:@"__host"]) {
      hostOverride = item.value;
    } else if ([item.name isEqualToString:@"__headers"]) {
      encodedHeaders = item.value;
    } else {
      [queryItems addObject:item];
    }
  }
  components.queryItems = queryItems.count > 0 ? queryItems : nil;
  if (hostOverride.length > 0) {
    components.scheme = @"https";
    components.host = hostOverride;
    components.port = @443;
  }
  NSURL *target = components.URL;
  if (requestID < 0 || target == nil || ![methods containsObject:method] ||
      ![self isAllowedURL:target rules:allowedHosts]) {
    [self resolveOwner:owner callID:callID response:[self errorResponse:requestID url:rawURL message:@"Invalid or disallowed proxy request."] binary:nil];
    return;
  }

  NSDictionary *headers = [command[@"headers"] isKindOfClass:[NSDictionary class]]
    ? command[@"headers"] : @{};
  NSString *corsOrigin = [headers[@"cors"] isKindOfClass:[NSString class]]
    ? headers[@"cors"] : @"*";
  if ([method isEqualToString:@"OPTIONS"]) {
    [self resolveOwner:owner callID:callID response:[self response:requestID status:200 url:target.absoluteString origin:corsOrigin includeMaxAge:YES] binary:nil];
    return;
  }

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:target];
  request.HTTPMethod = method;
  request.timeoutInterval = 30;
  [headers enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
    if ([key isKindOfClass:[NSString class]] && value != [NSNull null] &&
        [(NSString *)key caseInsensitiveCompare:@"cors"] != NSOrderedSame &&
        ![self isUnsafeHeader:key]) {
      [request setValue:[value description] forHTTPHeaderField:key];
    }
  }];
  [self applyEncodedHeaders:encodedHeaders request:request];
  if ([self isYouTubeHost:target.host]) {
    NSString *origin = [NSString stringWithFormat:@"https://%@", target.host];
    if ([request valueForHTTPHeaderField:@"Origin"] == nil) {
      [request setValue:origin forHTTPHeaderField:@"Origin"];
    }
    if ([request valueForHTTPHeaderField:@"Referer"] == nil) {
      [request setValue:[origin stringByAppendingString:@"/"] forHTTPHeaderField:@"Referer"];
    }
  }

  NSData *body = nil;
  if ([command[@"body"] isKindOfClass:[NSString class]]) {
    body = [command[@"body"] dataUsingEncoding:NSUTF8StringEncoding];
  } else if ([command[@"bodyBase64"] isKindOfClass:[NSString class]]) {
    body = [[NSData alloc] initWithBase64EncodedString:command[@"bodyBase64"] options:NSDataBase64DecodingIgnoreUnknownCharacters];
  }
  if (![method isEqualToString:@"GET"] && ![method isEqualToString:@"HEAD"]) {
    request.HTTPBody = body ?: [NSData data];
    if ([request valueForHTTPHeaderField:@"Content-Type"] == nil) {
      NSString *text = [command[@"body"] isKindOfClass:[NSString class]] ? command[@"body"] : nil;
      NSString *trimmed = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
      NSString *contentType = [trimmed hasPrefix:@"{"] || [trimmed hasPrefix:@"["]
        ? @"application/json; charset=utf-8"
        : text != nil ? @"text/plain; charset=utf-8" : @"application/octet-stream";
      [request setValue:contentType forHTTPHeaderField:@"Content-Type"];
    }
  }

  __weak RNCWebViewImpl *weakOwner = owner;
  __weak WKWebView *weakWebView = webView;
  [webView.configuration.websiteDataStore.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    RNCWebViewImpl *strongOwner = weakOwner;
    WKWebView *strongWebView = weakWebView;
    if (strongOwner == nil || strongWebView == nil) {
      return;
    }
    if ([request valueForHTTPHeaderField:@"Cookie"] == nil) {
      NSArray<NSHTTPCookie *> *matching = [self cookies:cookies matchingURL:target];
      NSString *cookie = [NSHTTPCookie requestHeaderFieldsWithCookies:matching][@"Cookie"];
      if (cookie.length > 0) {
        [request setValue:cookie forHTTPHeaderField:@"Cookie"];
      }
    }
    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
      dataTaskWithRequest:request
      completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error != nil) {
          [self resolveOwner:weakOwner callID:callID response:[self errorResponse:requestID url:target.absoluteString message:error.localizedDescription] binary:nil];
          return;
        }
        NSHTTPURLResponse *http = [response isKindOfClass:[NSHTTPURLResponse class]]
          ? (NSHTTPURLResponse *)response : nil;
        NSData *responseData = data ?: [NSData data];
        if (http == nil || responseData.length > RNCProxyMaxResponseBytes) {
          NSString *message = http == nil ? @"Invalid proxy response." : @"Proxy response is too large.";
          [self resolveOwner:weakOwner callID:callID response:[self errorResponse:requestID url:target.absoluteString message:message] binary:nil];
          return;
        }
        NSArray<NSHTTPCookie *> *responseCookies =
          [NSHTTPCookie cookiesWithResponseHeaderFields:http.allHeaderFields forURL:target];
        for (NSHTTPCookie *cookie in responseCookies) {
          [strongWebView.configuration.websiteDataStore.httpCookieStore setCookie:cookie completionHandler:nil];
        }
        NSMutableDictionary *result = [self response:requestID status:http.statusCode url:rawURL origin:corsOrigin includeMaxAge:NO];
        NSMutableDictionary *resultHeaders = result[@"headers"];
        BOOL fullHeader = [command[@"fullHeader"] boolValue];
        NSString *contentEncoding = [[self header:@"content-encoding" response:http] lowercaseString];
        BOOL decodedContent = [self isAutomaticallyDecodedContentEncoding:contentEncoding];
        NSSet *selected = [NSSet setWithArray:@[@"content-length", @"content-type", @"content-disposition", @"accept-ranges", @"content-range"]];
        [http.allHeaderFields enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
          NSString *name = [[key description] lowercaseString];
          if (fullHeader || [selected containsObject:name]) {
            resultHeaders[name] = [value description];
          }
        }];
        // NSURLSession transparently decodes gzip, deflate, and Brotli bodies.
        // Do not expose the stale transport headers or page code may decode the
        // already-decoded bytes a second time.
        if (decodedContent) {
          [resultHeaders removeObjectForKey:@"content-encoding"];
          [resultHeaders removeObjectForKey:@"content-length"];
        }
        NSString *contentType = [[self header:@"content-type" response:http] lowercaseString];
        if ([self isTextContentType:contentType]) {
          result[@"bodyType"] = @"string";
          result[@"body"] = [self stringFromData:responseData response:http] ?: @"";
          [self resolveOwner:weakOwner callID:callID response:result binary:nil];
        } else if (responseData.length == 0) {
          result[@"bodyType"] = @"string";
          result[@"body"] = [NSNull null];
          [self resolveOwner:weakOwner callID:callID response:result binary:nil];
        } else {
          result[@"bodyType"] = @"webMessage";
          result[@"body"] = [NSNull null];
          NSMutableData *binary = [NSMutableData dataWithCapacity:responseData.length + 4];
          uint32_t identifier = CFSwapInt32HostToBig((uint32_t)requestID);
          [binary appendBytes:&identifier length:sizeof(identifier)];
          [binary appendData:responseData];
          [self resolveOwner:weakOwner callID:callID response:result binary:binary];
        }
      }];
    [task resume];
  }];
}

+ (NSMutableDictionary *)response:(NSInteger)requestID
                           status:(NSInteger)status
                              url:(NSString *)url
                           origin:(NSString *)origin
                    includeMaxAge:(BOOL)includeMaxAge
{
  NSMutableDictionary *headers = [@{
    @"Access-Control-Allow-Origin": origin ?: @"*",
    @"Access-Control-Allow-Headers": @"*",
    @"Access-Control-Allow-Methods": @"GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  } mutableCopy];
  if (![origin isEqualToString:@"*"]) {
    headers[@"Access-Control-Allow-Credentials"] = @"true";
  }
  if (includeMaxAge) {
    headers[@"Access-Control-Max-Age"] = @"86400";
  }
  return [@{
    @"id": @(requestID),
    @"status": @(status),
    @"bodyType": @"string",
    @"body": [NSNull null],
    @"url": url ?: @"",
    @"headers": headers,
  } mutableCopy];
}

+ (NSMutableDictionary *)errorResponse:(NSInteger)requestID url:(NSString *)url message:(NSString *)message
{
  NSMutableDictionary *response = [self response:requestID status:502 url:url origin:@"*" includeMaxAge:NO];
  response[@"error"] = message ?: @"Proxy request failed.";
  return response;
}

+ (void)resolveOwner:(RNCWebViewImpl *)owner
              callID:(NSInteger)callID
            response:(NSDictionary *)response
              binary:(NSData * _Nullable)binary
{
  if (owner == nil) {
    return;
  }
  NSString *responseJSON = [self JSONString:response] ?: @"null";
  NSMutableString *script = [NSMutableString stringWithString:@"(function(){"];
  if (binary.length > 0) {
    NSString *base64 = [binary base64EncodedStringWithOptions:0];
    [script appendFormat:@"var r=atob(%@);var b=new Uint8Array(r.length);for(var i=0;i<r.length;i++)b[i]=r.charCodeAt(i);window.dispatchEvent(new MessageEvent('message',{data:b.buffer}));", [self JSONString:base64]];
  }
  [script appendFormat:@"window.flutter_inappwebview&&window.flutter_inappwebview.__rncBridgeResolve(%ld,true,%@);})();true;", (long)callID, responseJSON];
  dispatch_async(dispatch_get_main_queue(), ^{
    [owner injectJavaScript:script];
  });
}

+ (NSString *)JSONString:(id)value
{
  if (value == nil) {
    return @"null";
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
  return data == nil ? nil : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

+ (BOOL)isAllowedURL:(NSURL *)url rules:(NSArray<NSString *> *)rules
{
  NSString *scheme = url.scheme.lowercaseString;
  NSString *host = url.host.lowercaseString;
  BOOL localHTTP = [scheme isEqualToString:@"http"] &&
    ([host isEqualToString:@"localhost"] || [host isEqualToString:@"127.0.0.1"]);
  if (![scheme isEqualToString:@"https"] && !localHTTP) {
    return NO;
  }
  for (NSString *rawRule in rules ?: @[]) {
    NSString *rule = [rawRule.lowercaseString stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if ([rule isEqualToString:@"*"] || [host isEqualToString:rule]) {
      return YES;
    }
    if ([rule hasPrefix:@"*."]) {
      NSString *suffix = [rule substringFromIndex:1];
      NSString *base = [rule substringFromIndex:2];
      if ([host isEqualToString:base] || [host hasSuffix:suffix]) {
        return YES;
      }
    }
  }
  return NO;
}

+ (BOOL)isYouTubeHost:(NSString *)host
{
  NSString *normalized = host.lowercaseString;
  return [normalized isEqualToString:@"youtube.com"] || [normalized hasSuffix:@".youtube.com"];
}

+ (BOOL)isUnsafeHeader:(NSString *)name
{
  return [name caseInsensitiveCompare:@"host"] == NSOrderedSame ||
    [name caseInsensitiveCompare:@"content-length"] == NSOrderedSame ||
    [name caseInsensitiveCompare:@"connection"] == NSOrderedSame;
}

+ (void)applyEncodedHeaders:(NSString *)encoded request:(NSMutableURLRequest *)request
{
  if (encoded.length == 0) {
    return;
  }
  NSData *data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
  id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil];
  if ([value isKindOfClass:[NSDictionary class]]) {
    [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id key, id object, BOOL *stop) {
      if ([key isKindOfClass:[NSString class]] && ![self isUnsafeHeader:key]) {
        [request setValue:[object description] forHTTPHeaderField:key];
      }
    }];
  } else if ([value isKindOfClass:[NSArray class]]) {
    for (id entry in (NSArray *)value) {
      if ([entry isKindOfClass:[NSArray class]] && [entry count] >= 2) {
        NSString *key = [entry[0] description];
        if (![self isUnsafeHeader:key]) {
          [request setValue:[entry[1] description] forHTTPHeaderField:key];
        }
      } else if ([entry isKindOfClass:[NSDictionary class]]) {
        [(NSDictionary *)entry enumerateKeysAndObjectsUsingBlock:^(id key, id object, BOOL *stop) {
          if ([key isKindOfClass:[NSString class]] && ![self isUnsafeHeader:key]) {
            [request setValue:[object description] forHTTPHeaderField:key];
          }
        }];
      }
    }
  }
}

+ (NSArray<NSHTTPCookie *> *)cookies:(NSArray<NSHTTPCookie *> *)cookies matchingURL:(NSURL *)url
{
  NSString *host = url.host.lowercaseString;
  NSString *path = url.path.length > 0 ? url.path : @"/";
  BOOL secure = [url.scheme.lowercaseString isEqualToString:@"https"];
  NSMutableArray *result = [NSMutableArray array];
  for (NSHTTPCookie *cookie in cookies) {
    NSString *domain = cookie.domain.lowercaseString;
    if ([domain hasPrefix:@"."]) {
      domain = [domain substringFromIndex:1];
    }
    BOOL domainMatches = [host isEqualToString:domain] || [host hasSuffix:[@"." stringByAppendingString:domain]];
    BOOL pathMatches = cookie.path.length == 0 || [path hasPrefix:cookie.path];
    if (domainMatches && pathMatches && (!cookie.secure || secure)) {
      [result addObject:cookie];
    }
  }
  return result;
}

+ (NSString *)header:(NSString *)name response:(NSHTTPURLResponse *)response
{
  for (id key in response.allHeaderFields) {
    if ([[key description] caseInsensitiveCompare:name] == NSOrderedSame) {
      return [response.allHeaderFields[key] description];
    }
  }
  return @"";
}

+ (BOOL)isTextContentType:(NSString *)contentType
{
  return [contentType hasPrefix:@"text/"] || [contentType containsString:@"json"] ||
    [contentType containsString:@"xml"] || [contentType containsString:@"javascript"];
}

+ (BOOL)isAutomaticallyDecodedContentEncoding:(NSString *)contentEncoding
{
  if (contentEncoding.length == 0) {
    return NO;
  }
  NSSet<NSString *> *decodedEncodings = [NSSet setWithArray:@[@"br", @"gzip", @"deflate"]];
  NSArray<NSString *> *encodings = [contentEncoding componentsSeparatedByString:@","];
  for (NSString *rawEncoding in encodings) {
    NSString *encoding = [rawEncoding stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (encoding.length == 0 || ![decodedEncodings containsObject:encoding]) {
      return NO;
    }
  }
  return encodings.count > 0;
}

+ (NSString *)stringFromData:(NSData *)data response:(NSHTTPURLResponse *)response
{
  NSStringEncoding encoding = NSUTF8StringEncoding;
  if (response.textEncodingName.length > 0) {
    CFStringEncoding cfEncoding =
      CFStringConvertIANACharSetNameToEncoding((__bridge CFStringRef)response.textEncodingName);
    if (cfEncoding != kCFStringEncodingInvalidId) {
      encoding = CFStringConvertEncodingToNSStringEncoding(cfEncoding);
    }
  }
  return [[NSString alloc] initWithData:data encoding:encoding] ?:
    [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

@end
