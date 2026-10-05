#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// What `BGSRNErrorMessage` says for an `NSError` this bridge did not build.
FOUNDATION_EXPORT NSString *const BGSRNForeignErrorMessage;

/// A bridge error's developer-chosen identifier (a patch key, an attribute
/// name), kept apart from its description. `BGSRNErrorMessage` puts it where
/// the description says `{identifier}`.
FOUNDATION_EXPORT NSErrorUserInfoKey const BGSRNErrorIdentifierKey;

/// The ONE place this bridge reads an `NSError`'s message, for a rejection or
/// a log line.
///
/// An error in one of the bridge's own domains (`BGSRNJSONErrorDomain`,
/// `BGSRNReportErrorDomain`, `BGSRNExceptionsErrorDomain`) is built with a
/// string-literal description, optionally a `BGSRNErrorIdentifierKey`, and
/// optionally an `NSUnderlyingErrorKey`; `scripts/raw-messages.ts` fails the
/// build on any other construction. Its message is that description, with
/// the identifier in place of `{identifier}` and, when the underlying error
/// is the bridge's own too, `": "` and that error's message appended.
///
/// Any other error -- a system parser's, which can repeat the malformed
/// input, a file error, which names the path, the SDK's -- returns
/// `BGSRNForeignErrorMessage`: its text was never audited, and a rejection
/// reaches JS while a log line reaches the SDK's own log capture.
FOUNDATION_EXPORT NSString *BGSRNErrorMessage(NSError *_Nullable error);

NS_ASSUME_NONNULL_END
