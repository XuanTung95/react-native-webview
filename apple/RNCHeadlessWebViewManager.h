#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
// All methods are called on the main queue.
@interface RNCHeadlessWebViewManager : NSObject
- (instancetype)initWithEventSink:(void (^)(NSString *, NSString *, NSString *))sink;
- (BOOL)create:(NSString *)identifier options:(NSString *)options error:(NSError **)error;
- (nullable NSString *)command:(NSString *)identifier name:(NSString *)name payload:(NSString *)payload error:(NSError **)error;
- (void)dispose:(NSString *)identifier;
- (void)disposeAll;
@end
NS_ASSUME_NONNULL_END
