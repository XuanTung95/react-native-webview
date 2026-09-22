#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

@class RNCWebViewImpl;

NS_ASSUME_NONNULL_BEGIN

@interface RNCWebViewNativeProxy : NSObject

+ (BOOL)tryHandleMessage:(id)message
                 webView:(WKWebView *)webView
                   owner:(RNCWebViewImpl *)owner
            allowedHosts:(NSArray<NSString *> *)allowedHosts;

@end

NS_ASSUME_NONNULL_END
