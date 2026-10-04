#import "BGSRNErrorMessage.h"

#import "BGSRNExceptions.h"
#import "BGSRNJSON.h"
#import "BGSRNReportOps.h"

NSString *const BGSRNForeignErrorMessage = @"an unexpected native error";
NSErrorUserInfoKey const BGSRNErrorIdentifierKey = @"BGSRNErrorIdentifier";

static BOOL IsOwn(id error) {
  static NSSet<NSErrorDomain> *ownDomains;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    ownDomains = [NSSet setWithArray:@[ BGSRNJSONErrorDomain, BGSRNReportErrorDomain, BGSRNExceptionsErrorDomain ]];
  });
  return [error isKindOfClass:NSError.class] && [ownDomains containsObject:((NSError *)error).domain];
}

NSString *BGSRNErrorMessage(NSError *error) {
  if (!IsOwn(error)) {
    return BGSRNForeignErrorMessage;
  }
  // The keys themselves, not `localizedDescription`: without one, Foundation
  // generates text from the domain and code rather than returning nil.
  NSDictionary *info = error.userInfo;
  id description = info[NSLocalizedDescriptionKey];
  if (![description isKindOfClass:NSString.class]) {
    return BGSRNForeignErrorMessage;
  }
  NSString *message = description;
  id identifier = info[BGSRNErrorIdentifierKey];
  if ([identifier isKindOfClass:NSString.class]) {
    message = [message stringByReplacingOccurrencesOfString:@"{identifier}" withString:identifier];
  }
  id underlying = info[NSUnderlyingErrorKey];
  if (IsOwn(underlying)) {
    message = [NSString stringWithFormat:@"%@: %@", message, BGSRNErrorMessage(underlying)];
  }
  return message;
}
