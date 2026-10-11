#import "include/BGSRNPluginEndpoint.h"

NSString *const BGSRNPluginEndpointInfoKey = @"BugseeReactNativeEndpoint";

/// The iOS SDK's endpoint option key (src/options/endpoint.ts, IOS_ENDPOINT_KEY).
static NSString *const BGSRNEndpointOptionKey = @"endpoint";

NSDictionary *BGSRNOptionsWithPluginEndpoint(NSDictionary *_Nullable options, id _Nullable configured) {
  NSDictionary *given = options ?: @{};
  if (![configured isKindOfClass:[NSString class]] || given[BGSRNEndpointOptionKey] != nil) {
    return given;
  }
  NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  NSString *value = [(NSString *)configured stringByTrimmingCharactersInSet:whitespace];
  if (value.length == 0) {
    return given;
  }
  NSMutableDictionary *result = [given mutableCopy];
  result[BGSRNEndpointOptionKey] = value;
  return [result copy];
}
