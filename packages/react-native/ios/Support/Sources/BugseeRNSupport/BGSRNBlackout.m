#import "BGSRNBlackout.h"

BOOL BGSRNEndBlackoutForStopWithStatus(BugseeStatus status) {
  if (status == BugseeStatusStopped || ![Bugsee isBlackout]) {
    return NO;
  }
  [Bugsee endBlackout];
  return YES;
}

BOOL BGSRNEndBlackoutForStop(void) {
  Bugsee *instance = [Bugsee sharedInstance];
  return BGSRNEndBlackoutForStopWithStatus(instance != nil ? instance.status : BugseeStatusStopped);
}
