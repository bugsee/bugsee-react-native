#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The backend routes React Native JS exceptions on this exact substring
/// (`'ReactNativeWebException' in name`). Never rename it.
FOUNDATION_EXPORT NSString *const BGSRNReactNativeExceptionName;

FOUNDATION_EXPORT NSErrorDomain const BGSRNExceptionsErrorDomain;

/// What `+[Bugsee logException:reason:domain:skipFrames:completion:]` takes from the
/// JS options, besides `skipFrames`, which JS does not have.
@interface BGSRNExceptionOptions : NSObject
@property(nonatomic, copy, readonly, nullable) NSString *domain;
@end

@interface BGSRNExceptions : NSObject

/// `{domain?}`. nil for nil text. Unparseable text or a wrongly typed domain → nil
/// and `*error`. Other keys, `labels` and `includeVideo` among them, are ignored.
+ (nullable BGSRNExceptionOptions *)loggingOptionsFromJSON:(nullable NSString *)json
                                                     error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
