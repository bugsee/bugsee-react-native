#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// The backend routes React Native JS exceptions on this exact substring
/// (`'ReactNativeWebException' in name`). Never rename it.
FOUNDATION_EXPORT NSString *const BGSRNReactNativeExceptionName;

FOUNDATION_EXPORT NSErrorDomain const BGSRNExceptionsErrorDomain;

/// The wire options of one handled exception: only `domain`, which reaches the
/// SDK as an argument of `+logException:reason:domain:skipFrames:completion:`.
/// Labels and `includeVideo` are no longer options (7.0.0-beta7 removed
/// `BugseeExceptionLoggingOptions`; labels are set through a report handler).
@interface BGSRNExceptionOptions : NSObject
@property (nonatomic, copy, nullable) NSString *domain;
@end

@interface BGSRNExceptions : NSObject

/// `{domain?}` as `BGSRNExceptionOptions`. nil for nil text. Unparseable text
/// or a wrongly typed domain → nil and `*error`. Other keys are ignored.
+ (nullable BGSRNExceptionOptions *)loggingOptionsFromJSON:(nullable NSString *)json
                                                     error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
