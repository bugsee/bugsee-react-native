#import "BGSRNExceptions.h"

#import "BGSRNErrorMessage.h"
#import "BGSRNJSON.h"

NSString *const BGSRNReactNativeExceptionName = @"ReactNativeWebException";
NSErrorDomain const BGSRNExceptionsErrorDomain = @"BGSRNExceptionsErrorDomain";

/// Hands `made` to the caller's out-parameter. Every error this file makes is
/// built inline, with a string-literal description, so the scanner
/// (`scripts/raw-messages.ts`) can see that no value goes into it.
static id Fail(NSError **out, NSError *made) {
  if (out != NULL) {
    *out = made;
  }
  return nil;
}

static BOOL IsCFBoolean(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

@implementation BGSRNExceptions

+ (BugseeExceptionLoggingOptions *)loggingOptionsFromJSON:(NSString *)json error:(NSError **)error {
  if (json == nil) {
    if (error != NULL) {
      *error = nil;
    }
    return nil;
  }

  NSError *parseError = nil;
  NSDictionary<NSString *, id> *object = BGSRNJSONObject(json, &parseError);
  if (object == nil) {
    return Fail(error, [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                           code:1
                                       userInfo:@{
                                           NSLocalizedDescriptionKey : @"exception options are not a JSON object",
                                           NSUnderlyingErrorKey : parseError ?: NSNull.null,
                                       }]);
  }

  BugseeExceptionLoggingOptions *opts = [BugseeExceptionLoggingOptions new];
  // The SDK's own object defaults includeVideo to NO; JS's contract is YES
  // unless the caller set false. Force it before reading the wire.
  opts.includeVideo = YES;

  id domain = object[@"domain"];
  if (domain != nil) {
    if (![domain isKindOfClass:NSString.class]) {
      return Fail(error, [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey : @"domain must be a string"}]);
    }
    opts.exceptionDomain = (NSString *)domain;
  }

  id labels = object[@"labels"];
  if (labels != nil) {
    if (![labels isKindOfClass:NSArray.class]) {
      return Fail(error, [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey : @"labels must be an array of strings"}]);
    }
    NSMutableArray<NSString *> *kept = [NSMutableArray array];
    for (id element in (NSArray *)labels) {
      if (![element isKindOfClass:NSString.class]) {
        return Fail(error, [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                               code:1
                                           userInfo:@{NSLocalizedDescriptionKey : @"labels must be an array of strings"}]);
      }
      [kept addObject:element];
    }
    opts.labels = kept;
  }

  id includeVideo = object[@"includeVideo"];
  if (includeVideo != nil) {
    if (!IsCFBoolean(includeVideo)) {
      return Fail(error, [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey : @"includeVideo must be a boolean"}]);
    }
    opts.includeVideo = [(NSNumber *)includeVideo boolValue];
  }

  // Unknown keys (skipFrames, mergingRules, …) are ignored: JS already
  // rejects them, and a future key must not refuse a report the facade sent.
  if (error != NULL) {
    *error = nil;
  }
  return opts;
}

@end
