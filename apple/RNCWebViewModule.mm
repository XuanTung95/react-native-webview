#import "RNCWebViewModule.h"

#import "RNCWebViewDecisionManager.h"
#import "RNCHeadlessWebViewManager.h"

#import <React/RCTFabricComponentsPlugins.h>

@implementation RNCWebViewModule {
  RNCHeadlessWebViewManager *_headless;
  BOOL _headlessInvalidated;
}

RCT_EXPORT_MODULE(RNCWebViewModule)

- (RNCHeadlessWebViewManager *)headless {
  if (!_headless) {
    __weak RNCWebViewModule *weakSelf = self;
    _headless = [[RNCHeadlessWebViewManager alloc] initWithEventSink:^(NSString *identifier, NSString *type, NSString *data) {
      [weakSelf emitOnHeadlessEvent:@{@"id": identifier, @"type": type, @"data": data}];
    }];
  }
  return _headless;
}

RCT_EXPORT_METHOD(createHeadless:(NSString *)identifier options:(NSString *)options resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_headlessInvalidated) {
      reject(@"E_HEADLESS_CREATE", @"HeadlessWebView native module was invalidated.", nil);
      return;
    }
    NSError *error = nil;
    if ([[self headless] create:identifier options:options error:&error]) resolve(nil);
    else reject(@"E_HEADLESS_CREATE", error.localizedDescription, error);
  });
}

RCT_EXPORT_METHOD(disposeHeadless:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self->_headless dispose:identifier];
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(commandHeadless:(NSString *)identifier command:(NSString *)command payload:(NSString *)payload resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_headlessInvalidated) {
      reject(@"E_HEADLESS_COMMAND", @"HeadlessWebView native module was invalidated.", nil);
      return;
    }
    NSError *error = nil;
    NSString *result = [[self headless] command:identifier name:command payload:payload error:&error];
    if (result) resolve(result);
    else reject(@"E_HEADLESS_COMMAND", error.localizedDescription, error);
  });
}

- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_headlessInvalidated = YES;
    [self->_headless disposeAll];
    self->_headless = nil;
  });
}

RCT_EXPORT_METHOD(isFileUploadSupported:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    if (resolve) {
        resolve(@(YES));
    }
}

RCT_EXPORT_METHOD(shouldStartLoadWithLockIdentifier:(BOOL)shouldStart lockIdentifier:(double)lockIdentifier)
{
    [[RNCWebViewDecisionManager getInstance] setResult:shouldStart forLockIdentifier:(int)lockIdentifier];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeRNCWebViewModuleSpecJSI>(params);
}

Class RNCWebViewModuleCls(void) {
  return RNCWebViewModule.class;
}

@end
