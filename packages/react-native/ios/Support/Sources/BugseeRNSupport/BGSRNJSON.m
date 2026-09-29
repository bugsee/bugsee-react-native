#import "BGSRNJSON.h"

NSErrorDomain const BGSRNJSONErrorDomain = @"BGSRNJSONErrorDomain";

static id Fail(NSError **error, NSString *message) {
  if (error != NULL) {
    *error = [NSError errorWithDomain:BGSRNJSONErrorDomain
                                 code:1
                             userInfo:@{NSLocalizedDescriptionKey : message}];
  }
  return nil;
}

NSDictionary<NSString *, id> *BGSRNJSONObject(NSString *json, NSError **error) {
  if (![json isKindOfClass:NSString.class]) {
    return Fail(error, @"expected a JSON object, got nil");
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSError *parseError = nil;
  // No reading options: containers come back immutable, NSNull stays in them,
  // and a top-level fragment (a bare string or number) is an error. Trailing
  // text after the object is one too.
  id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
  if (value == nil) {
    return Fail(error, [NSString stringWithFormat:@"malformed JSON: %@",
                                                  parseError.localizedDescription ?: @"not UTF-8"]);
  }
  if (![value isKindOfClass:NSDictionary.class]) {
    return Fail(error, @"expected a JSON object");
  }
  return value;
}
