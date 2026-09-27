#import "RNCHeadlessWebViewManager.h"
#import "RNCWebViewImpl.h"

@implementation RNCHeadlessWebViewManager {
  NSMutableDictionary<NSString *, RNCWebViewImpl *> *_views;
  void (^_sink)(NSString *, NSString *, NSString *);
}

- (instancetype)initWithEventSink:(void (^)(NSString *, NSString *, NSString *))sink {
  if ((self = [super init])) {
    _views = [NSMutableDictionary new];
    _sink = [sink copy];
  }
  return self;
}

static void RNCHeadlessError(NSError **error, NSString *message) {
  if (error) *error = [NSError errorWithDomain:@"RNCHeadlessWebView" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

#if !TARGET_OS_OSX
- (UIWindow *)hostingWindow {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState != UISceneActivationStateForegroundActive || ![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) return window;
    }
  }
  return nil;
}

- (BOOL)setSize:(NSDictionary *)size view:(RNCWebViewImpl *)view window:(UIWindow *)window error:(NSError **)error {
  double width = [size[@"width"] doubleValue], height = [size[@"height"] doubleValue];
  if (!size[@"width"] || !size[@"height"] || !isfinite(width) || !isfinite(height) ||
      (width < 0 && width != -1) || (height < 0 && height != -1)) {
    RNCHeadlessError(error, @"Invalid headless size.");
    return NO;
  }
  view.frame = CGRectMake(0, 0, width == -1 ? window.bounds.size.width : width,
                         height == -1 ? window.bounds.size.height : height);
  [view setNeedsLayout];
  [view layoutIfNeeded];
  return YES;
}

- (RCTDirectEventBlock)eventBlock:(NSString *)type identifier:(NSString *)identifier view:(RNCWebViewImpl *)view {
  __weak RNCHeadlessWebViewManager *weakSelf = self;
  __weak RNCWebViewImpl *weakView = view;
  return ^(NSDictionary *event) {
    RNCHeadlessWebViewManager *owner = weakSelf;
    if (!owner || !weakView || owner->_views[identifier] != weakView) return;
    NSMutableDictionary *data = [event mutableCopy];
    [data removeObjectForKey:@"target"];
    NSData *json = [NSJSONSerialization dataWithJSONObject:data options:0 error:nil];
    if (json) owner->_sink(identifier, type, [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    if ([type isEqualToString:@"terminated"]) {
      dispatch_async(dispatch_get_main_queue(), ^{ [owner dispose:identifier]; });
    }
  };
}
#endif

- (BOOL)create:(NSString *)identifier options:(NSString *)options error:(NSError **)error {
#if TARGET_OS_OSX
  RNCHeadlessError(error, @"HeadlessWebView currently supports iOS and Android.");
  return NO;
#else
  if (_views[identifier]) { RNCHeadlessError(error, @"HeadlessWebView ID already exists."); return NO; }
  UIWindow *window = [self hostingWindow];
  if (!window) { RNCHeadlessError(error, @"HeadlessWebView requires an active application window."); return NO; }
  NSDictionary *config = [NSJSONSerialization JSONObjectWithData:[options dataUsingEncoding:NSUTF8StringEncoding] options:0 error:error];
  if (![config isKindOfClass:NSDictionary.class]) return NO;
  RNCWebViewImpl *view = [[RNCWebViewImpl alloc] initWithFrame:CGRectMake(0, 0, 1, 1)];
  // Keep the WKWebView attached to the window: detached views can stop executing JS.
  view.alpha = 0.01;
  view.userInteractionEnabled = NO;
  view.accessibilityElementsHidden = YES;
  view.autoManageStatusBarEnabled = NO;
  view.deferInitialLoad = YES;
  view.sharedCookiesEnabled = YES;
  view.allowsInlineMediaPlayback = YES;
  view.messagingEnabled = YES;
  view.scrollEnabled = NO;
  for (NSString *key in @[@"userAgent", @"javaScriptEnabled", @"cacheEnabled", @"sharedCookiesEnabled",
                          @"allowsInlineMediaPlayback", @"mediaPlaybackRequiresUserAction", @"webviewDebuggingEnabled",
                          @"messagingOriginRules", @"injectedJavaScript", @"injectedJavaScriptBeforeContentLoaded"]) {
    if (config[key] && config[key] != NSNull.null) [view setValue:config[key] forKey:key];
  }
  NSDictionary *size = config[@"initialSize"] ?: @{@"width": @1, @"height": @1};
  if (![self setSize:size view:view window:window error:error]) return NO;
  _views[identifier] = view;
  view.onLoadingStart = [self eventBlock:@"loadStart" identifier:identifier view:view];
  view.onLoadingFinish = [self eventBlock:@"loadStop" identifier:identifier view:view];
  view.onLoadingProgress = [self eventBlock:@"progress" identifier:identifier view:view];
  view.onLoadingError = [self eventBlock:@"error" identifier:identifier view:view];
  view.onHttpError = [self eventBlock:@"httpError" identifier:identifier view:view];
  view.onMessage = [self eventBlock:@"message" identifier:identifier view:view];
  view.onContentProcessDidTerminate = [self eventBlock:@"terminated" identifier:identifier view:view];
  [window insertSubview:view atIndex:0];
  [view setNeedsLayout];
  [view layoutIfNeeded];
  return YES;
#endif
}

- (NSString *)command:(NSString *)identifier name:(NSString *)name payload:(NSString *)payload error:(NSError **)error {
  RNCWebViewImpl *view = _views[identifier];
  if (!view) { RNCHeadlessError(error, @"HeadlessWebView is not running."); return nil; }
  NSDictionary *data = [NSJSONSerialization JSONObjectWithData:[payload dataUsingEncoding:NSUTF8StringEncoding] options:0 error:error];
  if (![data isKindOfClass:NSDictionary.class]) return nil;
  if ([name isEqualToString:@"load"]) {
    view.source = data;
  } else if ([name isEqualToString:@"reload"]) {
    [view reload];
  } else if ([name isEqualToString:@"stop"]) {
    [view stopLoading];
  } else if ([name isEqualToString:@"executeJavaScript"]) {
    [view executeJavaScript:[data[@"id"] doubleValue] source:data[@"source"] argumentsJSON:data[@"arguments"] asynchronous:[data[@"asynchronous"] boolValue]];
  } else if ([name isEqualToString:@"inject"]) {
    [view injectJavaScript:data[@"script"]];
#if !TARGET_OS_OSX
  } else if ([name isEqualToString:@"setSize"]) {
    if (![self setSize:data view:view window:view.window error:error]) return nil;
  } else if ([name isEqualToString:@"getSize"]) {
    NSDictionary *size = @{@"width": @(view.frame.size.width), @"height": @(view.frame.size.height)};
    NSData *json = [NSJSONSerialization dataWithJSONObject:size options:0 error:error];
    return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : nil;
#endif
  } else {
    RNCHeadlessError(error, [@"Unknown headless command: " stringByAppendingString:name]);
    return nil;
  }
  return @"null";
}

- (void)dispose:(NSString *)identifier {
  RNCWebViewImpl *view = _views[identifier];
  if (!view) return;
  [_views removeObjectForKey:identifier];
  view.onLoadingStart = nil;
  view.onLoadingFinish = nil;
  view.onLoadingProgress = nil;
  view.onLoadingError = nil;
  view.onHttpError = nil;
  view.onMessage = nil;
  view.onContentProcessDidTerminate = nil;
  [view stopLoading];
  [view destroyWebView];
  [view removeFromSuperview];
}

- (void)disposeAll {
  for (NSString *identifier in _views.allKeys) [self dispose:identifier];
}
@end
