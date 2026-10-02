#import "BGSRNSecureRectanglePulls.h"

#import <os/lock.h>

#import "BGSRNSecureRectangles.h"

const NSTimeInterval BGSRNOriginRefreshMinInterval = 0.1;

/// Runs `refresher` without letting an exception reach the SDK's pull.
static void BGSRNRunRefresher(dispatch_block_t refresher) {
  @try {
    refresher();
  } @catch (NSException *exception) {
    NSLog(@"[Bugsee] secure rectangles: the origin refresh threw: %@", exception);
  }
}

@implementation BGSRNSecureRectanglePulls {
  BGSRNSecureRectangles *_store;
  NSTimeInterval (^_clock)(void);
  os_unfair_lock _lock;
  /// Guarded by `_lock`.
  BOOL _hasRefreshed;
  NSTimeInterval _lastRefresh;
}

+ (BGSRNSecureRectanglePulls *)shared {
  static BGSRNSecureRectanglePulls *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [[BGSRNSecureRectanglePulls alloc]
        initWithStore:BGSRNSecureRectangles.shared
                clock:^NSTimeInterval {
                  return NSProcessInfo.processInfo.systemUptime;
                }];
  });
  return shared;
}

- (instancetype)initWithStore:(BGSRNSecureRectangles *)store
                        clock:(NSTimeInterval (^)(void))clock {
  self = [super init];
  if (self) {
    _store = store;
    _clock = [clock copy];
    _lock = OS_UNFAIR_LOCK_INIT;
  }
  return self;
}

- (NSData *)pullForDisplay:(NSInteger)display {
  dispatch_block_t refresher = self.refresher;
  if (refresher != nil && [self claimRefresh]) {
    if (NSThread.isMainThread) {
      BGSRNRunRefresher(refresher);
    } else {
      dispatch_async(dispatch_get_main_queue(), ^{
        BGSRNRunRefresher(refresher);
      });
    }
  }
  return [_store snapshotForDisplay:display];
}

/// YES when a refresh is due, and records it as made: the first pull, then
/// one per `BGSRNOriginRefreshMinInterval`.
- (BOOL)claimRefresh {
  const NSTimeInterval now = _clock();
  os_unfair_lock_lock(&_lock);
  const BOOL due = !_hasRefreshed || now - _lastRefresh >= BGSRNOriginRefreshMinInterval;
  if (due) {
    _hasRefreshed = YES;
    _lastRefresh = now;
  }
  os_unfair_lock_unlock(&_lock);
  return due;
}

@end
