#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const BGSRNReportErrorDomain;

/// Why a report operation refused. Each maps to one stable wire code of
/// `src/report/errors.ts` through `BGSRNReportErrorWireCode`.
typedef NS_ERROR_ENUM(BGSRNReportErrorDomain, BGSRNReportError) {
  /// `E_REPORT_BAD_ARGUMENT`: nothing was applied.
  BGSRNReportErrorBadArgument = 1,
  /// `E_REPORT_ATTACHMENT_REJECTED`: the SDK returned nil for the attachment.
  BGSRNReportErrorAttachmentRejected = 2,
};

/// The JS error code for an error from `BGSRNReportOps`, or nil for any other.
FOUNDATION_EXPORT NSString *_Nullable BGSRNReportErrorWireCode(NSError *error);

/// The `BugseeReport` operations, between the JS wire shape and the SDK's
/// `BGSReportContract`. The iOS mirror of Android's `ReportOps`.
///
/// Called on the module's own method queue, never the main queue: the
/// contract's methods are lock-synchronized (`BGSContracts.h`), and there is
/// no need to hop -- the SDK does not block main waiting on us, and hopping
/// would only queue an op behind whatever UI work is already there, eating
/// into the handle's deadline for nothing.
@interface BGSRNReportOps : NSObject

/// The snapshot `reportRead` returns: `summary`, `description` (both omitted
/// when unset), `severity` (0..5 as the SDK holds it -- 0 is "not set", which
/// JS reads as undefined), `labels`, `attributes` (string/number/boolean
/// values only), `screenshotDisplayIds` (ascending) and `attachmentNames`.
+ (NSDictionary<NSString *, id> *)readReport:(id<BGSReportContract>)report;

/// Applies a `reportUpdate` patch: validates every field first, and only then
/// touches the report, so a rejected patch changes nothing.
+ (BOOL)applyPatch:(NSDictionary *)patch
          toReport:(id<BGSReportContract>)report
             error:(NSError **)error;

/// The validation half of `applyPatch:toReport:error:`. nil, with `error`,
/// when any field is invalid — the caller applies nothing. Otherwise the
/// patch, with attribute numbers already in the form the SDK should store
/// (an exact integer as an integer). `BGSRNCreatedReportOps` applies the
/// same dictionary through `BugseeExtendedReport`'s own setters.
+ (nullable NSDictionary<NSString *, id> *)validatedPatch:(NSDictionary *)patch
                                                     error:(NSError **)error;

/// `applyPatch:toReport:error:` on the JSON text `reportUpdate` receives
/// (`BGSRNJSONObject`), which is how a `null` -- clear the summary or
/// description, remove an attribute -- survives the bridge. Text that is not
/// a JSON object is `BGSRNReportErrorBadArgument`, and nothing is applied.
+ (BOOL)applyPatchJSON:(NSString *)json
              toReport:(id<BGSReportContract>)report
                 error:(NSError **)error;

/// `addAttachmentWithFilePath:name:mimeType:move:`. NO with
/// `BGSRNReportErrorAttachmentRejected` when the SDK returns nil.
+ (BOOL)addFileAtPath:(NSString *)path
                 name:(NSString *)name
             mimeType:(nullable NSString *)mimeType
                 move:(BOOL)move
             toReport:(id<BGSReportContract>)report
                error:(NSError **)error;

/// Decodes `base64` and calls `addAttachmentWithData:name:mimeType:`. NO with
/// `BGSRNReportErrorBadArgument` when it does not decode (and the SDK is not
/// called), or `BGSRNReportErrorAttachmentRejected` when the SDK returns nil.
+ (BOOL)addData:(NSString *)base64
           name:(NSString *)name
       mimeType:(nullable NSString *)mimeType
       toReport:(id<BGSReportContract>)report
          error:(NSError **)error;

/// What a rejection says when `operation` (e.g. `"reportRead"`) faults with an
/// `NSException`: the operation only, never the exception's `reason`, which
/// can echo report content. The iOS mirror of Android's
/// `ReportOps.failureMessage`.
+ (NSString *)failureMessageForOperation:(NSString *)operation;

@end

NS_ASSUME_NONNULL_END
