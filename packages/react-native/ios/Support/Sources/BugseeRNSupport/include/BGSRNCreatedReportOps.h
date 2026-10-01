#import <Foundation/Foundation.h>
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// Mirrors the SDK's `ATTACHMENTS_LIMIT`. A created report drops anything past
/// this at upload, silently; the bridge rejects at add time instead.
FOUNDATION_EXPORT const NSUInteger BGSRNCreatedReportAttachmentMaxCount;

/// Mirrors the SDK's `MAX_SIZE_ATTACHMENT` (3 MiB). Same rule: reject up front.
FOUNDATION_EXPORT const NSUInteger BGSRNCreatedReportAttachmentMaxBytes;

/// `BugseeExtendedReport` is not a `BGSReportContract`. Same wire keys as
/// `BGSRNReportOps`, different setters, and the SDK's attachment limits
/// applied here because upload would otherwise drop the file and still succeed.
@interface BGSRNCreatedReportOps : NSObject

/// `summary`, `description` (omitted when unset), `severity` (as held, 0 when
/// the SDK has not been given one), `labels`, `attributes`, `screenshotDisplayIds`
/// (`@[@0]` when a screenshot is set, else empty) and `attachmentNames`.
+ (NSDictionary<NSString *, id> *)readReport:(BugseeExtendedReport *)report;

/// `validatedPatch:error:` first, so a bad field changes nothing. Then
/// `setSummary:` / `setDescription:` (NSNull clears), `setSeverity:`, labels
/// replaced by assignment, `clearAllAttributes` before attribute edits,
/// `clearAttribute:` for NSNull and `setAttribute:withValue:` otherwise.
+ (BOOL)applyPatchJSON:(NSString *)json
              toReport:(BugseeExtendedReport *)report
                 error:(NSError **)error;

/// `BGSRNReportErrorBadArgument` when `base64` does not decode.
/// `BGSRNReportErrorAttachmentRejected` when the report already holds
/// `BGSRNCreatedReportAttachmentMaxCount`, or the data is empty or over
/// `BGSRNCreatedReportAttachmentMaxBytes`.
+ (BOOL)addData:(NSString *)base64
           name:(NSString *)name
       toReport:(BugseeExtendedReport *)report
          error:(NSError **)error;

/// Size from the file's attributes before any read, then the bytes are read
/// now: a later overwrite of `path` must not change the attachment.
/// `BGSRNReportErrorAttachmentRejected` when the report is full, the file is
/// missing or unreadable, or it is empty or over the byte limit.
+ (BOOL)addFileAtPath:(NSString *)path
                 name:(NSString *)name
             toReport:(BugseeExtendedReport *)report
                error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
