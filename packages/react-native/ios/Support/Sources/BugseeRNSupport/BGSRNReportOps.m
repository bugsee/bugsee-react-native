#import "BGSRNReportOps.h"
#import "BGSRNErrorMessage.h"
#import "BGSRNJSON.h"

#include <math.h>

NSErrorDomain const BGSRNReportErrorDomain = @"BGSRNReportErrorDomain";

NSString *BGSRNReportErrorWireCode(NSError *error) {
  if (![error.domain isEqualToString:BGSRNReportErrorDomain]) {
    return nil;
  }
  switch ((BGSRNReportError)error.code) {
    case BGSRNReportErrorBadArgument:
      return @"E_REPORT_BAD_ARGUMENT";
    case BGSRNReportErrorAttachmentRejected:
      return @"E_REPORT_ATTACHMENT_REJECTED";
  }
  return nil;
}

/// JS numbers are doubles; beyond 2^53 a double is no longer an exact integer.
static const double kMaxSafeInteger = 9007199254740992.0;

/// Hands `made` to the caller's out-parameter. Every error this file makes is
/// built inline, with a string-literal description, so the scanner
/// (`scripts/raw-messages.ts`) can see that no value goes into it.
static BOOL Fail(NSError **out, NSError *made) {
  if (out != NULL) {
    *out = made;
  }
  return NO;
}

/// A JS boolean crosses as the CFBoolean singleton, which is also an NSNumber;
/// a JS number never does. The two must not be confused either way.
static BOOL IsBoolean(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL IsFiniteNumber(id value) {
  return [value isKindOfClass:NSNumber.class] && !IsBoolean(value) && isfinite([value doubleValue]);
}

/// The value the SDK should store for a JS number: an integer when it is an
/// exact one (so an attribute of 3 is stored as 3, not 3.0), a double otherwise.
static NSNumber *WireNumber(NSNumber *number) {
  const double value = number.doubleValue;
  if (value == floor(value) && fabs(value) <= kMaxSafeInteger) {
    return @((long long)value);
  }
  return @(value);
}

@implementation BGSRNReportOps

+ (NSDictionary<NSString *, id> *)readReport:(id<BGSReportContract>)report {
  NSMutableDictionary<NSString *, id> *result = [NSMutableDictionary dictionary];

  // Omitted when unset rather than NSNull: JS reads either as undefined.
  NSString *summary = report.summary;
  if ([summary isKindOfClass:NSString.class]) {
    result[@"summary"] = summary;
  }
  NSString *description = report.reportDescription;
  if ([description isKindOfClass:NSString.class]) {
    result[@"description"] = description;
  }

  // By value. 0 is "not set" and passes through; JS maps it to undefined.
  result[@"severity"] = @((NSInteger)report.severity);

  NSMutableArray<NSString *> *labels = [NSMutableArray array];
  for (id label in report.labels) {
    if ([label isKindOfClass:NSString.class]) {
      [labels addObject:label];
    }
  }
  result[@"labels"] = labels;

  // The JS type is string | number | boolean; anything else has no
  // representation there, and a description would read as a real value.
  NSMutableDictionary<NSString *, id> *attributes = [NSMutableDictionary dictionary];
  [report.attributes enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *stop) {
    if ([key isKindOfClass:NSString.class] &&
        ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class])) {
      attributes[key] = value;
    }
  }];
  result[@"attributes"] = attributes;

  // The SDK documents these ascending; sorted again so the wire contract does
  // not rest on that.
  NSMutableArray<NSNumber *> *displayIds = [NSMutableArray array];
  for (id displayId in report.screenshotDisplayIds) {
    if ([displayId isKindOfClass:NSNumber.class]) {
      [displayIds addObject:displayId];
    }
  }
  result[@"screenshotDisplayIds"] = [displayIds sortedArrayUsingSelector:@selector(compare:)];

  NSMutableArray<NSString *> *attachmentNames = [NSMutableArray array];
  for (id<BGSAttachmentContract> attachment in report.attachments) {
    NSString *name = attachment.name;
    if ([name isKindOfClass:NSString.class]) {
      [attachmentNames addObject:name];
    }
  }
  result[@"attachmentNames"] = attachmentNames;
  return result;
}

+ (nullable NSDictionary<NSString *, id> *)validatedPatch:(NSDictionary *)patch
                                                     error:(NSError **)error {
  static NSSet<NSString *> *knownKeys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    knownKeys = [NSSet setWithArray:@[ @"summary", @"description", @"severity", @"labels",
                                       @"clearAttributes", @"attributes" ]];
  });
  for (id key in patch) {
    if (![knownKeys containsObject:key]) {
      Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                      code:BGSRNReportErrorBadArgument
                                  userInfo:@{
                                      NSLocalizedDescriptionKey : @"update() received an unknown key \"{identifier}\"",
                                      BGSRNErrorIdentifierKey : key,
                                  }]);
      return nil;
    }
  }

  // Validate everything first. Nothing below the next comment can reject.
  id summary = patch[@"summary"];
  if (summary != nil && summary != NSNull.null && ![summary isKindOfClass:NSString.class]) {
    Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                    code:BGSRNReportErrorBadArgument
                                userInfo:@{NSLocalizedDescriptionKey : @"summary must be a string or null"}]);
    return nil;
  }
  id description = patch[@"description"];
  if (description != nil && description != NSNull.null && ![description isKindOfClass:NSString.class]) {
    Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                    code:BGSRNReportErrorBadArgument
                                userInfo:@{NSLocalizedDescriptionKey : @"description must be a string or null"}]);
    return nil;
  }

  // Checked 1..5 HERE: the SDK setter ignores anything else and keeps the
  // current value, silently -- `setSeverity(0)` would resolve as if it had
  // worked.
  id severity = patch[@"severity"];
  if (severity != nil) {
    const double value = IsFiniteNumber(severity) ? [severity doubleValue] : NAN;
    if (!(value == floor(value) && value >= BugseeSeverityLow && value <= BugseeSeverityBlocker)) {
      // Never the value itself: anything JS allows can arrive here.
      Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                      code:BGSRNReportErrorBadArgument
                                  userInfo:@{NSLocalizedDescriptionKey : @"severity must be an integer 1..5"}]);
      return nil;
    }
  }

  id labels = patch[@"labels"];
  if (labels != nil) {
    if (![labels isKindOfClass:NSArray.class]) {
      Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                      code:BGSRNReportErrorBadArgument
                                  userInfo:@{NSLocalizedDescriptionKey : @"labels must be an array of strings"}]);
      return nil;
    }
    for (id label in (NSArray *)labels) {
      if (![label isKindOfClass:NSString.class]) {
        Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                        code:BGSRNReportErrorBadArgument
                                    userInfo:@{NSLocalizedDescriptionKey : @"labels must all be strings"}]);
        return nil;
      }
    }
  }

  id clearAttributes = patch[@"clearAttributes"];
  if (clearAttributes != nil && !(IsBoolean(clearAttributes) && [clearAttributes boolValue])) {
    Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                    code:BGSRNReportErrorBadArgument
                                userInfo:@{NSLocalizedDescriptionKey : @"clearAttributes must be true when present"}]);
    return nil;
  }

  id rawAttributes = patch[@"attributes"];
  NSMutableDictionary<NSString *, id> *attributes = nil;
  if (rawAttributes != nil) {
    if (![rawAttributes isKindOfClass:NSDictionary.class]) {
      Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                      code:BGSRNReportErrorBadArgument
                                  userInfo:@{NSLocalizedDescriptionKey : @"attributes must be a plain object"}]);
      return nil;
    }
    attributes = [NSMutableDictionary dictionary];
    for (id key in (NSDictionary *)rawAttributes) {
      id value = ((NSDictionary *)rawAttributes)[key];
      const BOOL valid = value == NSNull.null || [value isKindOfClass:NSString.class] ||
                         IsBoolean(value) || IsFiniteNumber(value);
      if (![key isKindOfClass:NSString.class] || !valid) {
        Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                        code:BGSRNReportErrorBadArgument
                                    userInfo:@{
                                        NSLocalizedDescriptionKey : @"attribute \"{identifier}\" must be a string, boolean, finite number or null",
                                        BGSRNErrorIdentifierKey : key,
                                    }]);
        return nil;
      }
      // Parity with the JS proxy, which rejects it before crossing.
      if ([(NSString *)key length] == 0) {
        Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                        code:BGSRNReportErrorBadArgument
                                    userInfo:@{NSLocalizedDescriptionKey : @"attribute name must be a non-empty string"}]);
        return nil;
      }
      attributes[key] = IsFiniteNumber(value) ? WireNumber(value) : value;
    }
  }

  NSMutableDictionary<NSString *, id> *valid = [NSMutableDictionary dictionary];
  if (summary != nil) {
    valid[@"summary"] = summary;
  }
  if (description != nil) {
    valid[@"description"] = description;
  }
  if (severity != nil) {
    valid[@"severity"] = severity;
  }
  if (labels != nil) {
    valid[@"labels"] = labels;
  }
  if (clearAttributes != nil) {
    valid[@"clearAttributes"] = clearAttributes;
  }
  if (attributes != nil) {
    valid[@"attributes"] = attributes;
  }
  return valid;
}

+ (BOOL)applyPatch:(NSDictionary *)patch
          toReport:(id<BGSReportContract>)report
             error:(NSError **)error {
  NSDictionary<NSString *, id> *valid = [self validatedPatch:patch error:error];
  if (valid == nil) {
    return NO;
  }

  // Everything is valid; apply.
  id summary = valid[@"summary"];
  if (summary != nil) {
    report.summary = summary == NSNull.null ? nil : summary;
  }
  id description = valid[@"description"];
  if (description != nil) {
    report.reportDescription = description == NSNull.null ? nil : description;
  }
  id severity = valid[@"severity"];
  if (severity != nil) {
    report.severity = (BugseeSeverityLevel)[severity integerValue];
  }
  id labels = valid[@"labels"];
  if (labels != nil) {
    // One atomic call: clear-then-add would expose a label-less report between the two.
    [report replaceLabels:labels];
  }
  if (valid[@"clearAttributes"] != nil) {
    // Before the attributes, so clear-then-set holds whatever order the patch
    // was written in.
    [report clearAllAttributes];
  }
  [valid[@"attributes"] enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *stop) {
    if (value == NSNull.null) {
      [report removeAttributeForName:key];
    } else {
      [report setAttribute:value forName:key];
    }
  }];
  return YES;
}

+ (BOOL)applyPatchJSON:(NSString *)json
              toReport:(id<BGSReportContract>)report
                 error:(NSError **)error {
  NSError *parseError = nil;
  NSDictionary *patch = BGSRNJSONObject(json, &parseError);
  if (patch == nil) {
    return Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                           code:BGSRNReportErrorBadArgument
                                       userInfo:@{
                                           NSLocalizedDescriptionKey : @"update() patch is not a JSON object",
                                           NSUnderlyingErrorKey : parseError ?: NSNull.null,
                                       }]);
  }
  return [self applyPatch:patch toReport:report error:error];
}

+ (BOOL)addFileAtPath:(NSString *)path
                 name:(NSString *)name
             mimeType:(NSString *)mimeType
                 move:(BOOL)move
             toReport:(id<BGSReportContract>)report
                error:(NSError **)error {
  id<BGSAttachmentContract> added = [report addAttachmentWithFilePath:path name:name mimeType:mimeType move:move];
  if (added == nil) {
    return Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                           code:BGSRNReportErrorAttachmentRejected
                                       userInfo:@{NSLocalizedDescriptionKey : @"The SDK declined the attachment"}]);
  }
  return YES;
}

+ (BOOL)addData:(NSString *)base64
           name:(NSString *)name
       mimeType:(NSString *)mimeType
       toReport:(id<BGSReportContract>)report
          error:(NSError **)error {
  NSData *data = [base64 isKindOfClass:NSString.class]
      ? [[NSData alloc] initWithBase64EncodedString:base64 options:0]
      : nil;
  if (data == nil) {
    return Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                           code:BGSRNReportErrorBadArgument
                                       userInfo:@{NSLocalizedDescriptionKey : @"data must be base64-encoded"}]);
  }
  id<BGSAttachmentContract> added = [report addAttachmentWithData:data name:name mimeType:mimeType];
  if (added == nil) {
    return Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain
                                           code:BGSRNReportErrorAttachmentRejected
                                       userInfo:@{NSLocalizedDescriptionKey : @"The SDK declined the attachment"}]);
  }
  return YES;
}

+ (NSString *)failureMessageForOperation:(NSString *)operation {
  return [operation stringByAppendingString:@" failed"];
}

@end
