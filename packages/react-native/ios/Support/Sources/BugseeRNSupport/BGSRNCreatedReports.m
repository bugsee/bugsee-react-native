#import "BGSRNCreatedReports.h"

#import <os/lock.h>

@implementation BGSRNCreatedReports {
  os_unfair_lock _lock;
  /// Set by `reserve`, cleared when that reservation is fulfilled or cleared.
  /// A held report keeps the slot on its own: this flag is only "the SDK has
  /// not answered yet".
  BOOL _creating;
  /// Token of the open reservation. 0 is never live.
  NSUInteger _reservation;
  NSUInteger _nextReservation;
  NSString *_handle;
  BugseeExtendedReport *_report;
  NSUInteger _nextHandle;
}

- (instancetype)init {
  if ((self = [super init])) {
    _lock = OS_UNFAIR_LOCK_INIT;
    _nextReservation = 1;
    _nextHandle = 1;
  }
  return self;
}

+ (BGSRNCreatedReports *)shared {
  static BGSRNCreatedReports *shared;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [self new];
  });
  return shared;
}

- (NSUInteger)reserve {
  os_unfair_lock_lock(&_lock);
  NSUInteger token = 0;
  if (!_creating && _report == nil) {
    _creating = YES;
    if (_nextReservation == 0) {
      _nextReservation = 1;
    }
    token = _nextReservation;
    _reservation = token;
    _nextReservation += 1;
    if (_nextReservation == 0) {
      _nextReservation = 1;
    }
  }
  os_unfair_lock_unlock(&_lock);
  return token;
}

- (nullable NSString *)fulfil:(nullable BugseeExtendedReport *)report
                 reservation:(NSUInteger)reservation {
  os_unfair_lock_lock(&_lock);
  NSString *handle = nil;
  // A late completion still runs after `clear` or after this reservation
  // already ended. It must not mint a handle on the next runtime's slot, and
  // a nil must not drop a report that slot already holds.
  if (_creating && reservation != 0 && reservation == _reservation) {
    _creating = NO;
    _reservation = 0;
    if (report != nil) {
      handle = [NSString stringWithFormat:@"cr-%lu", (unsigned long)_nextHandle];
      _nextHandle += 1;
      _handle = handle;
      _report = report;
    }
  }
  os_unfair_lock_unlock(&_lock);
  return handle;
}

- (nullable BugseeExtendedReport *)reportFor:(NSString *)handleId {
  os_unfair_lock_lock(&_lock);
  BugseeExtendedReport *report = [_handle isEqualToString:handleId] ? _report : nil;
  os_unfair_lock_unlock(&_lock);
  return report;
}

- (nullable BugseeExtendedReport *)take:(NSString *)handleId {
  os_unfair_lock_lock(&_lock);
  BugseeExtendedReport *report = nil;
  if ([_handle isEqualToString:handleId]) {
    report = _report;
    _report = nil;
    _handle = nil;
  }
  os_unfair_lock_unlock(&_lock);
  return report;
}

- (void)clear {
  os_unfair_lock_lock(&_lock);
  _creating = NO;
  _reservation = 0;
  _report = nil;
  _handle = nil;
  os_unfair_lock_unlock(&_lock);
}

@end
