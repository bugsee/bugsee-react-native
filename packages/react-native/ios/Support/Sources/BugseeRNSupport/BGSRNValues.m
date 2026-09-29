#import "include/BGSRNValues.h"

NSNumber *BGSRNBoolNumber(BOOL value) {
  return (__bridge NSNumber *)(value ? kCFBooleanTrue : kCFBooleanFalse);
}
