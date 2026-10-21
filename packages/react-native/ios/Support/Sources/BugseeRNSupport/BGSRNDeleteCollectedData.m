#import "BGSRNDeleteCollectedData.h"

const int64_t BGSRNDeleteCollectedDataBackstopMs = 60000;

NSString *const BGSRNDeleteTimeoutCode = @"E_DELETE_TIMEOUT";

void BGSRNDeleteCollectedData(BGSRNDeleteSDKCall sdkCall,
                              int64_t backstopMs,
                              dispatch_queue_t queue,
                              void (^resolve)(BOOL success),
                              void (^reject)(NSString *code)) {
  // Every touch of `settled` is on `queue`, which is serial, so a plain flag
  // is enough: the completion and the backstop cannot interleave.
  __block BOOL settled = NO;

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, backstopMs * (int64_t)NSEC_PER_MSEC), queue, ^{
    if (settled) {
      return;
    }
    settled = YES;
    reject(BGSRNDeleteTimeoutCode);
  });

  sdkCall(^(BOOL success) {
    dispatch_async(queue, ^{
      if (settled) {
        return;
      }
      settled = YES;
      resolve(success);
    });
  });
}
