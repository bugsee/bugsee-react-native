#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// What `BGSRNErrorMessage` says for an `NSError` this bridge did not build.
FOUNDATION_EXPORT NSString *const BGSRNForeignErrorMessage;

/// The ONE place this bridge reads an `NSError`'s message, for a rejection or
/// a log line.
///
/// An error in one of the bridge's own domains (`BGSRNJSONErrorDomain`,
/// `BGSRNReportErrorDomain`, `BGSRNExceptionsErrorDomain`) carries a message
/// the bridge built from fixed text and identifiers only (a patch key, an
/// attribute name), never a value; that message is returned. Any other error
/// -- a system parser's, which can repeat the malformed input, a file error,
/// which names the path, the SDK's -- returns `BGSRNForeignErrorMessage`:
/// its text was never audited, and a rejection reaches JS while a log line
/// reaches the SDK's own log capture.
///
/// `scripts/raw-messages.ts` fails the build on a `localizedDescription` or
/// `userInfo` read anywhere else.
FOUNDATION_EXPORT NSString *BGSRNErrorMessage(NSError *_Nullable error);

NS_ASSUME_NONNULL_END
