#import "BGSRNReportDeadlines.h"

const int64_t BGSRNLiveDeadlineMs = 25000;
const int64_t BGSRNRecoveryDeadlineMs = 2500;

int64_t BGSRNDeadlineMs(BOOL onMainThread) {
  return onMainThread ? BGSRNLiveDeadlineMs : BGSRNRecoveryDeadlineMs;
}
