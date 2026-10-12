#import "include/BGSRNLaunchHold.h"
#import "include/BGSRNMainThread.h"

// WORKAROUND for https://github.com/bugsee/bugsee-cocoa/issues/227 -- see
// BGSRNLaunchHold.h. Remove once that is fixed.

const NSUInteger BGSRNLaunchHoldCapacity = 64;
const int64_t BGSRNLaunchHoldDeadlineMs = 30000;

static NSString *const kLaunched = @"com.bugsee.lifecycle.Launched";
static NSString *const kStopping = @"com.bugsee.lifecycle.Stopping";
static NSString *const kStopped = @"com.bugsee.lifecycle.Stopped";

@interface BGSRNHeldCall : NSObject
@property (nonatomic, copy) NSString *label;
@property (nonatomic, copy) BGSRNGatedCall call;
@end

@implementation BGSRNHeldCall
@end

@implementation BGSRNLaunchHold {
  NSUInteger _capacity;
  int64_t _deadlineMs;
  BugseeStatus (^_status)(void);
  NSMutableArray<BGSRNHeldCall *> *_held;
  /// Bumped whenever the held calls are settled, so a deadline armed for an
  /// earlier batch does nothing to a later one.
  NSUInteger _generation;
}

+ (BGSRNLaunchHold *)shared {
  static BGSRNLaunchHold *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [[BGSRNLaunchHold alloc] initWithCapacity:BGSRNLaunchHoldCapacity
                                            deadlineMs:BGSRNLaunchHoldDeadlineMs
                                                status:^BugseeStatus {
                                                  Bugsee *instance = [Bugsee sharedInstance];
                                                  return instance != nil ? instance.status : BugseeStatusStopped;
                                                }];
  });
  return shared;
}

- (instancetype)initWithCapacity:(NSUInteger)capacity
                      deadlineMs:(int64_t)deadlineMs
                          status:(BugseeStatus (^)(void))status {
  if ((self = [super init])) {
    _capacity = capacity;
    _deadlineMs = deadlineMs;
    _status = [status copy];
    _held = [NSMutableArray array];
  }
  return self;
}

- (NSUInteger)heldCount {
  return _held.count;
}

- (void)submit:(NSString *)label call:(BGSRNGatedCall)call {
  if (call == nil) {
    return;
  }
  const BugseeStatus status = _status();
  if (status == BugseeStatusLaunching) {
    if (_held.count >= _capacity) {
      NSLog(@"BugseeRN %@ dropped: %lu calls are already held until launched (bugsee-cocoa#227)",
            label, (unsigned long)_held.count);
      call(BGSRNGatedRunDrop);
      return;
    }
    BGSRNHeldCall *held = [BGSRNHeldCall new];
    held.label = label;
    held.call = call;
    [_held addObject:held];
    NSLog(@"BugseeRN %@ held until launched (bugsee-cocoa#227) held=%lu", label,
          (unsigned long)_held.count);
    if (_held.count == 1) {
      [self armDeadline];
    }
    return;
  }
  // Whatever is held goes first: Launched can be visible here before its
  // lifecycle event has arrived, and this call must not overtake older ones.
  [self settleWithStatus:status reason:@"status changed"];
  call(BGSRNGatedRunNow);
}

- (void)lifecycleEvent:(NSString *)name {
  if (![name isEqualToString:kLaunched] && ![name isEqualToString:kStopping] &&
      ![name isEqualToString:kStopped]) {
    return;
  }
  // The SDK delivers lifecycle events on its own queue; the hold lives on main.
  BGSRNRunOnMain(^{
    [self settleWithStatus:self->_status() reason:name];
  });
}

/// Replays everything held when `status` is Launched, drops it when it is
/// anything but Launching, and keeps holding while it is still Launching (a
/// Launched event from an earlier launch, overtaken by a stop and a
/// relaunch, must not release the new launch's calls).
- (void)settleWithStatus:(BugseeStatus)status reason:(NSString *)reason {
  if (_held.count == 0 || status == BugseeStatusLaunching) {
    return;
  }
  NSArray<BGSRNHeldCall *> *held = [_held copy];
  [_held removeAllObjects];
  _generation += 1;
  const BOOL replay = status == BugseeStatusLaunched;
  if (replay) {
    NSLog(@"BugseeRN launched: replaying %lu held call(s) (bugsee-cocoa#227)",
          (unsigned long)held.count);
  } else {
    NSLog(@"BugseeRN launch did not complete (%@, status=%ld): dropping %lu held call(s) "
          @"(bugsee-cocoa#227)",
          reason, (long)status, (unsigned long)held.count);
  }
  for (BGSRNHeldCall *entry in held) {
    entry.call(replay ? BGSRNGatedRunReplay : BGSRNGatedRunDrop);
  }
}

- (void)armDeadline {
  if (_deadlineMs <= 0) {
    return;
  }
  const NSUInteger generation = _generation;
  __weak __typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, _deadlineMs * (int64_t)NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
                   __typeof(self) strongSelf = weakSelf;
                   if (strongSelf == nil || strongSelf->_generation != generation) {
                     return;
                   }
                   BugseeStatus status = strongSelf->_status();
                   // Still Launching at the deadline: give up on this launch.
                   // Anything else settles as the event would have.
                   [strongSelf settleWithStatus:status == BugseeStatusLaunching ? BugseeStatusStopped : status
                                         reason:@"deadline"];
                 });
}

@end
