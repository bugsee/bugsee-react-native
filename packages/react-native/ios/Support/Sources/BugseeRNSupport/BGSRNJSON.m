#import "BGSRNJSON.h"

NSErrorDomain const BGSRNJSONErrorDomain = @"BGSRNJSONErrorDomain";

/// Hands `made` to the caller's out-parameter. Every error this file makes is
/// built inline, with a string-literal description, so the scanner
/// (`scripts/raw-messages.ts`) can see that no value goes into it.
static id Fail(NSError **out, NSError *made) {
  if (out != NULL) {
    *out = made;
  }
  return nil;
}

NSDictionary<NSString *, id> *BGSRNJSONObject(NSString *json, NSError **error) {
  if (![json isKindOfClass:NSString.class]) {
    return Fail(error, [NSError errorWithDomain:BGSRNJSONErrorDomain
                                           code:1
                                       userInfo:@{NSLocalizedDescriptionKey : @"expected a JSON object, got nil"}]);
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSError *parseError = nil;
  // No reading options: containers come back immutable, NSNull stays in them,
  // and a top-level fragment (a bare string or number) is an error. Trailing
  // text after the object is one too.
  id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
  if (value == nil) {
    // Fixed, never the parser's own diagnostic: that can repeat fragments of
    // the malformed text, which a rejection or log line must not carry.
    return Fail(error, [NSError errorWithDomain:BGSRNJSONErrorDomain
                                           code:1
                                       userInfo:@{NSLocalizedDescriptionKey : @"malformed JSON"}]);
  }
  if (![value isKindOfClass:NSDictionary.class]) {
    return Fail(error, [NSError errorWithDomain:BGSRNJSONErrorDomain
                                           code:1
                                       userInfo:@{NSLocalizedDescriptionKey : @"expected a JSON object"}]);
  }
  return value;
}
