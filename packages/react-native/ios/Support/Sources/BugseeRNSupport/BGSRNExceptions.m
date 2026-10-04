#import "BGSRNExceptions.h"

#import "BGSRNErrorMessage.h"
#import "BGSRNJSON.h"

NSString *const BGSRNReactNativeExceptionName = @"ReactNativeWebException";
NSErrorDomain const BGSRNExceptionsErrorDomain = @"BGSRNExceptionsErrorDomain";

static id Fail(NSError **error, NSString *message) {
  if (error != NULL) {
    *error = [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                 code:1
                             userInfo:@{NSLocalizedDescriptionKey : message}];
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
    return Fail(error, BGSRNErrorMessage(parseError));
  }

  BugseeExceptionLoggingOptions *opts = [BugseeExceptionLoggingOptions new];
  // The SDK's own object defaults includeVideo to NO; JS's contract is YES
  // unless the caller set false. Force it before reading the wire.
  opts.includeVideo = YES;

  id domain = object[@"domain"];
  if (domain != nil) {
    if (![domain isKindOfClass:NSString.class]) {
      return Fail(error, @"domain must be a string");
    }
    opts.exceptionDomain = (NSString *)domain;
  }

  id labels = object[@"labels"];
  if (labels != nil) {
    if (![labels isKindOfClass:NSArray.class]) {
      return Fail(error, @"labels must be an array of strings");
    }
    NSMutableArray<NSString *> *kept = [NSMutableArray array];
    for (id element in (NSArray *)labels) {
      if (![element isKindOfClass:NSString.class]) {
        return Fail(error, @"labels must be an array of strings");
      }
      [kept addObject:element];
    }
    opts.labels = kept;
  }

  id includeVideo = object[@"includeVideo"];
  if (includeVideo != nil) {
    if (!IsCFBoolean(includeVideo)) {
      return Fail(error, @"includeVideo must be a boolean");
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
