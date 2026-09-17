#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Whether an app token is usable.
///
/// Deliberately permissive about shape — the token's format is the server's
/// business, and a wrapper rejecting a valid token because the format changed
/// would be worse than one that forwarded it. Only genuinely unusable input,
/// absent or whitespace, is refused, and refused early so the failure names
/// the real problem instead of surfacing later as a confusing launch failure.
FOUNDATION_EXPORT BOOL BGSRNTokenIsUsable(NSString *_Nullable token);

NS_ASSUME_NONNULL_END
