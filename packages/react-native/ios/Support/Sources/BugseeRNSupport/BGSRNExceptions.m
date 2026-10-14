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

@implementation BGSRNExceptionOptions

- (instancetype)initWithDomain:(NSString *)domain {
  self = [super init];
  if (self) {
    _domain = [domain copy];
  }
  return self;
}

@end

@implementation BGSRNExceptions

+ (BGSRNExceptionOptions *)loggingOptionsFromJSON:(NSString *)json error:(NSError **)error {
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

  NSString *domainValue = nil;

  id domain = object[@"domain"];
  if (domain != nil) {
    if (![domain isKindOfClass:NSString.class]) {
      return Fail(error, [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                             code:1
                                         userInfo:@{NSLocalizedDescriptionKey : @"domain must be a string"}]);
    }
    domainValue = (NSString *)domain;
  }

  // Unknown keys (labels, skipFrames, mergingRules, includeVideo, …) are
  // ignored: JS already rejects them, and a future key must not refuse a report
  // the facade sent.
  if (error != NULL) {
    *error = nil;
  }
  return [[BGSRNExceptionOptions alloc] initWithDomain:domainValue];
}

@end
