#import "include/BGSRNTokens.h"

BOOL BGSRNTokenIsUsable(NSString *_Nullable token) {
  if (![token isKindOfClass:[NSString class]]) {
    return NO;
  }
  NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  return [token stringByTrimmingCharactersInSet:whitespace].length > 0;
}
