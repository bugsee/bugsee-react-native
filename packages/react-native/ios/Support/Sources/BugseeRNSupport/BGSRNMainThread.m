#import "BGSRNMainThread.h"

void BGSRNRunOnMain(dispatch_block_t block) {
  if (block == nil) {
    return;
  }
  if ([NSThread isMainThread]) {
    block();
    return;
  }
  dispatch_async(dispatch_get_main_queue(), block);
}
