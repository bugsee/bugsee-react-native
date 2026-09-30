#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// The backend routes React Native JS exceptions on this exact substring
/// (`'ReactNativeWebException' in name`). Never rename it.
FOUNDATION_EXPORT NSString *const BGSRNReactNativeExceptionName;

FOUNDATION_EXPORT NSErrorDomain const BGSRNExceptionsErrorDomain;

@interface BGSRNExceptions : NSObject

/// `{domain?, labels?, includeVideo?}` as SDK options: domain →
/// `exceptionDomain`; `includeVideo` defaults to YES (the SDK's own object
/// defaults to NO). nil for nil text. Unparseable text or a wrongly typed
/// value → nil and `*error`.
+ (nullable BugseeExceptionLoggingOptions *)loggingOptionsFromJSON:(nullable NSString *)json
                                                             error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
