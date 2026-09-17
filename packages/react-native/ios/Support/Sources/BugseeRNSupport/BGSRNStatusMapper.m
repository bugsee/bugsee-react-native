#import "include/BGSRNStatusMapper.h"

NSInteger BGSRNStatusToWire(BugseeStatus status) {
  switch (status) {
    case BugseeStatusLaunching:
      return BGSRNStatusWireLaunching;
    case BugseeStatusLaunched:
      return BGSRNStatusWireLaunched;
    case BugseeStatusStopping:
      return BGSRNStatusWireStopping;
    case BugseeStatusStopped:
      return BGSRNStatusWireStopped;
  }
  // Not a `default:` inside the switch on purpose: with every case listed,
  // the compiler warns when the SDK adds one, which is the signal we want.
  // This only catches a value cast in from outside the enum's range.
  return BGSRNStatusWireStopped;
}
