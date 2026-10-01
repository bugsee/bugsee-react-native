#import "BGSRNCreatedReportOps.h"
#import "BGSRNJSON.h"
#import "BGSRNReportOps.h"

const NSUInteger BGSRNCreatedReportAttachmentMaxCount = 3;
const NSUInteger BGSRNCreatedReportAttachmentMaxBytes = 3u * 1024u * 1024u;

static BOOL Fail(NSError **error, BGSRNReportError code, NSString *message) {
  if (error != NULL) {
    *error = [NSError errorWithDomain:BGSRNReportErrorDomain
                                 code:code
                             userInfo:@{NSLocalizedDescriptionKey : message}];
  }
  return NO;
}

/// The one count check. Upload drops anything past `ATTACHMENTS_LIMIT` and
/// still succeeds; rejecting here is the only way JS hears about it.
static BOOL AtAttachmentLimit(BugseeExtendedReport *report) {
  return report.attachments.count >= BGSRNCreatedReportAttachmentMaxCount;
}

@implementation BGSRNCreatedReportOps

+ (NSDictionary<NSString *, id> *)readReport:(BugseeExtendedReport *)report {
  NSMutableDictionary<NSString *, id> *result = [NSMutableDictionary dictionary];

  NSString *summary = report.summary;
  if ([summary isKindOfClass:NSString.class]) {
    result[@"summary"] = summary;
  }
  NSString *description = report.reportDescription;
  if ([description isKindOfClass:NSString.class]) {
    result[@"description"] = description;
  }

  result[@"severity"] = @((NSInteger)report.severity);

  NSMutableArray<NSString *> *labels = [NSMutableArray array];
  for (id label in report.labels) {
    if ([label isKindOfClass:NSString.class]) {
      [labels addObject:label];
    }
  }
  result[@"labels"] = labels;

  NSMutableDictionary<NSString *, id> *attributes = [NSMutableDictionary dictionary];
  [report.attributes enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
    if ([key isKindOfClass:NSString.class] &&
        ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class])) {
      attributes[key] = value;
    }
  }];
  result[@"attributes"] = attributes;

  // One display. The extended report has a screenshot or it does not; the
  // wire shape is still the handler's list of display ids.
  result[@"screenshotDisplayIds"] = report.screenshot != nil ? @[ @0 ] : @[];

  NSMutableArray<NSString *> *attachmentNames = [NSMutableArray array];
  for (BugseeAttachment *attachment in report.attachments) {
    NSString *name = attachment.name;
    if ([name isKindOfClass:NSString.class]) {
      [attachmentNames addObject:name];
    }
  }
  result[@"attachmentNames"] = attachmentNames;
  return result;
}

+ (BOOL)applyPatchJSON:(NSString *)json
              toReport:(BugseeExtendedReport *)report
                 error:(NSError **)error {
  NSError *parseError = nil;
  NSDictionary *patch = BGSRNJSONObject(json, &parseError);
  if (patch == nil) {
    return Fail(error, BGSRNReportErrorBadArgument,
                [NSString stringWithFormat:@"update() patch is not a JSON object: %@",
                                           parseError.localizedDescription]);
  }
  NSDictionary<NSString *, id> *valid = [BGSRNReportOps validatedPatch:patch error:error];
  if (valid == nil) {
    return NO;
  }

  id summary = valid[@"summary"];
  if (summary != nil) {
    [report setSummary:summary == NSNull.null ? nil : summary];
  }
  id description = valid[@"description"];
  if (description != nil) {
    [report setDescription:description == NSNull.null ? nil : description];
  }
  id severity = valid[@"severity"];
  if (severity != nil) {
    [report setSeverity:(BugseeSeverityLevel)[severity integerValue]];
  }
  id labels = valid[@"labels"];
  if (labels != nil) {
    // Assignment replaces. There is no clear-then-add on this class.
    report.labels = labels;
  }
  if (valid[@"clearAttributes"] != nil) {
    [report clearAllAttributes];
  }
  [valid[@"attributes"] enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *stop) {
    if (value == NSNull.null) {
      [report clearAttribute:key];
    } else {
      [report setAttribute:key withValue:value];
    }
  }];
  return YES;
}

+ (BOOL)attachData:(NSData *)data
              name:(NSString *)name
          toReport:(BugseeExtendedReport *)report
             error:(NSError **)error {
  if (AtAttachmentLimit(report)) {
    return Fail(error, BGSRNReportErrorAttachmentRejected,
                [NSString stringWithFormat:@"a created report holds at most %lu attachments",
                                           (unsigned long)BGSRNCreatedReportAttachmentMaxCount]);
  }
  if (data.length == 0 || data.length > BGSRNCreatedReportAttachmentMaxBytes) {
    return Fail(error, BGSRNReportErrorAttachmentRejected,
                @"a created-report attachment must be non-empty and at most 3 MiB");
  }
  BugseeAttachment *attachment = [BugseeAttachment attachmentWithName:name filename:name data:data];
  if (attachment == nil) {
    return Fail(error, BGSRNReportErrorAttachmentRejected, @"The SDK declined the attachment");
  }
  [report setAttachment:attachment];
  return YES;
}

+ (BOOL)addData:(NSString *)base64
           name:(NSString *)name
       toReport:(BugseeExtendedReport *)report
          error:(NSError **)error {
  if (![base64 isKindOfClass:NSString.class]) {
    return Fail(error, BGSRNReportErrorBadArgument, @"data must be base64-encoded");
  }
  // An empty string decodes to empty data, which the SDK drops at upload.
  // Reject it as an attachment, not as bad base64: the encoding is valid.
  if (base64.length == 0) {
    return Fail(error, BGSRNReportErrorAttachmentRejected,
                @"a created-report attachment must be non-empty and at most 3 MiB");
  }
  NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (data == nil) {
    return Fail(error, BGSRNReportErrorBadArgument, @"data must be base64-encoded");
  }
  return [self attachData:data name:name toReport:report error:error];
}

+ (BOOL)addFileAtPath:(NSString *)path
                 name:(NSString *)name
             toReport:(BugseeExtendedReport *)report
                error:(NSError **)error {
  if (AtAttachmentLimit(report)) {
    return Fail(error, BGSRNReportErrorAttachmentRejected,
                [NSString stringWithFormat:@"a created report holds at most %lu attachments",
                                           (unsigned long)BGSRNCreatedReportAttachmentMaxCount]);
  }

  // The link's own length is the target path, not the file. Resolve first,
  // then take that size, so a short symlink cannot admit a target over 3 MiB
  // and the bytes we then read are the file we measured.
  NSString *resolved = path.stringByResolvingSymlinksInPath;
  if (resolved.length == 0) {
    resolved = path;
  }
  NSError *attrError = nil;
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:resolved error:&attrError];
  if (attributes == nil) {
    return Fail(error, BGSRNReportErrorAttachmentRejected, @"the file is missing or unreadable");
  }
  const unsigned long long size = [attributes[NSFileSize] unsignedLongLongValue];
  if (size == 0 || size > (unsigned long long)BGSRNCreatedReportAttachmentMaxBytes) {
    return Fail(error, BGSRNReportErrorAttachmentRejected,
                @"a created-report attachment must be non-empty and at most 3 MiB");
  }

  NSError *readError = nil;
  NSData *read = [NSData dataWithContentsOfFile:resolved options:0 error:&readError];
  if (read == nil) {
    return Fail(error, BGSRNReportErrorAttachmentRejected, @"the file is missing or unreadable");
  }
  // Own the bytes. The file is the app's; overwriting it later must not
  // change what the report will upload.
  NSData *owned = [NSData dataWithBytes:read.bytes length:read.length];
  return [self attachData:owned name:name toReport:report error:error];
}

@end
