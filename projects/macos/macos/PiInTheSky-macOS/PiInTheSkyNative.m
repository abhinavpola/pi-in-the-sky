#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PiInTheSkyNative, NSObject)

RCT_EXTERN_METHOD(
  authenticate:(NSString *)authorizeUrl
  callbackScheme:(NSString *)callbackScheme
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  loadConnectionConfig:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  saveConnectionConfig:(NSString *)payload
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  clearConnectionConfig:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  randomBase64Url:(nonnull NSNumber *)byteLength
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

@end
