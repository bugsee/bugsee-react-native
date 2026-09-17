#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// What the SDK asks a wrapper to say about itself.
///
/// The values are gathered in JS and handed down, because that is where they
/// are knowable: the React Native version comes from `Platform.constants`, the
/// engine from whether Hermes installed its global, and the build
/// configuration from `__DEV__`. Nothing here infers them natively, which
/// would produce a second, disagreeing answer.
///
/// Declared without conforming to `BugseeWrapper` here so that this package
/// stays testable on its own; the bridge declares the conformance, which is
/// where the SDK header is in scope.
@interface BGSRNWrapper : NSObject

@property(nonatomic, copy, readonly) NSString *wrapperType;
@property(nonatomic, copy, readonly) NSString *wrapperVersion;
@property(nonatomic, copy, readonly, nullable) NSString *wrapperBuild;
@property(nonatomic, copy, readonly, nullable) NSDictionary<NSString *, NSString *> *context;

/// Builds a wrapper from the identity dictionary the bridge received.
///
/// Missing values become "unknown" rather than nil: the SDK declares
/// `wrapperType` and `wrapperVersion` non-null, and an empty string reads in a
/// report as "this wrapper has no version".
+ (instancetype)wrapperWithIdentity:(nullable NSDictionary *)identity;

@end

NS_ASSUME_NONNULL_END
