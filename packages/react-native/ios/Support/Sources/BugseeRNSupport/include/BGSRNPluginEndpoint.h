#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The Info.plist key the Expo config plugin writes its `endpoint` option to
/// (plugin/src/index.ts, IOS_ENDPOINT_PLIST_KEY), already in the form the iOS
/// SDK's `endpoint` launch option takes, with the API version.
FOUNDATION_EXPORT NSString *const BGSRNPluginEndpointInfoKey;

/// `options` with the configured endpoint as its `endpoint` when JS passed
/// none, or `options` itself. An endpoint JS passed always wins; a missing,
/// non-string or blank configured value changes nothing, so the SDK keeps its
/// own default. `options` is never modified.
FOUNDATION_EXPORT NSDictionary *BGSRNOptionsWithPluginEndpoint(NSDictionary *_Nullable options,
                                                               id _Nullable configured);

NS_ASSUME_NONNULL_END
