#import "BGSRNErrorMessage.h"

#import "BGSRNExceptions.h"
#import "BGSRNJSON.h"
#import "BGSRNReportOps.h"

NSString *const BGSRNForeignErrorMessage = @"an unexpected native error";

NSString *BGSRNErrorMessage(NSError *error) {
  static NSSet<NSErrorDomain> *ownDomains;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    ownDomains = [NSSet setWithArray:@[ BGSRNJSONErrorDomain, BGSRNReportErrorDomain, BGSRNExceptionsErrorDomain ]];
  });
  if (error == nil || ![ownDomains containsObject:error.domain]) {
    return BGSRNForeignErrorMessage;
  }
  // The key itself, not `localizedDescription`: without one, Foundation
  // generates text from the domain and code rather than returning nil.
  id message = error.userInfo[NSLocalizedDescriptionKey];
  return [message isKindOfClass:NSString.class] ? message : BGSRNForeignErrorMessage;
}
