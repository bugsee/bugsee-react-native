#import "BGSRNBlackout.h"

BOOL BGSRNEndBlackoutForStop(BOOL (^isBlackout)(void), dispatch_block_t end) {
  if (!isBlackout()) {
    return NO;
  }
  end();
  return YES;
}
