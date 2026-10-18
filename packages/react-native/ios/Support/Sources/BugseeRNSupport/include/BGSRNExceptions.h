#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// The backend routes React Native JS exceptions on this exact substring
/// (`'ReactNativeWebException' in name`). Never rename it.
FOUNDATION_EXPORT NSString *const BGSRNReactNativeExceptionName;

FOUNDATION_EXPORT NSErrorDomain const BGSRNExceptionsErrorDomain;

/// The wire options of one handled exception. 7.0.0-beta7 removed
/// `BugseeExceptionLoggingOptions`: only `domain` still reaches the SDK (as an
/// argument of `+logException:reason:domain:skipFrames:completion:`). `labels`
/// and `includeVideo` are parsed and validated like before, but the SDK has no
/// per-call way to take them.
@interface BGSRNExceptionOptions : NSObject
@property (nonatomic, copy, nullable) NSString *domain;
@property (nonatomic, copy, nullable) NSArray<NSString *> *labels;
/// YES unless the caller sent false.
@property (nonatomic) BOOL includeVideo;
@end

@interface BGSRNExceptions : NSObject

/// `{domain?, labels?, includeVideo?}` as `BGSRNExceptionOptions`;
/// `includeVideo` defaults to YES. nil for nil text. Unparseable text or a
/// wrongly typed value → nil and `*error`.
+ (nullable BGSRNExceptionOptions *)loggingOptionsFromJSON:(nullable NSString *)json
                                                     error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
