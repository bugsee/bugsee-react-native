#import "include/BGSRNReportArgs.h"

#import <Bugsee/Bugsee.h>

const NSInteger BGSRNDefaultBugPriorityFallback = 3;

static BOOL BGSRNIntegralSeverity(id raw, NSInteger *out) {
  if (![raw isKindOfClass:[NSNumber class]]) {
    return NO;
  }
  // A boolean is an NSNumber whose integer value is 0 or 1. It is not a
  // severity the launch option was given as.
  if (CFGetTypeID((__bridge CFTypeRef)raw) == CFBooleanGetTypeID()) {
    return NO;
  }
  const double value = [(NSNumber *)raw doubleValue];
  if (value < 1.0 || value > 5.0 || value != (NSInteger)value) {
    return NO;
  }
  *out = (NSInteger)value;
  return YES;
}

NSInteger BGSRNUploadSeverity(NSInteger requested, NSDictionary *_Nullable launchOptions) {
  if (requested >= 1 && requested <= 5) {
    return requested;
  }
  NSInteger option = 0;
  id raw = launchOptions[BugseeOptionReportingDefaultBugPriority];
  if (BGSRNIntegralSeverity(raw, &option)) {
    return option;
  }
  return BGSRNDefaultBugPriorityFallback;
}

NSArray<NSString *> *_Nullable BGSRNStringArray(NSArray *_Nullable raw) {
  if (raw == nil) {
    return nil;
  }
  NSMutableArray<NSString *> *result = [NSMutableArray arrayWithCapacity:raw.count];
  for (id item in raw) {
    if ([item isKindOfClass:[NSString class]]) {
      [result addObject:item];
    }
  }
  return result;
}
