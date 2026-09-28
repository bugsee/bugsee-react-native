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
/// contract's methods are lock-synchronized (`BGSContracts.h`), and on the
/// live path main is the thread the SDK is holding while it waits for us.
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

@end

NS_ASSUME_NONNULL_END
