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
  /// Set by `detachForUpload:` until `endUpload:` for that generation. The
  /// handle is already gone; the slot stays taken so a second `createReport`
  /// cannot construct another `BugseeExtendedReport` while `uploadReport:` is
  /// still copying this one. beta3 keeps attributes in a file-scope global.
  BOOL _uploading;
  /// Generation of the in-flight upload. 0 is never live. `clear` moves it so
  /// a completion from the upload `clear` abandoned cannot end a later one.
  NSUInteger _uploadGeneration;
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
  if (!_creating && _report == nil && !_uploading) {
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

- (nullable BugseeExtendedReport *)detachForUpload:(NSString *)handleId
                                        generation:(NSUInteger *)generationOut {
  os_unfair_lock_lock(&_lock);
  BugseeExtendedReport *report = nil;
  NSUInteger generation = 0;
  if ([_handle isEqualToString:handleId] && _report != nil) {
    report = _report;
    _report = nil;
    _handle = nil;
    _uploading = YES;
    _uploadGeneration += 1;
    if (_uploadGeneration == 0) {
      _uploadGeneration = 1;
    }
    generation = _uploadGeneration;
  }
  os_unfair_lock_unlock(&_lock);
  if (generationOut != NULL) {
    *generationOut = generation;
  }
  return report;
}

- (void)endUpload:(NSUInteger)generation {
  os_unfair_lock_lock(&_lock);
  if (generation != 0 && generation == _uploadGeneration) {
    _uploading = NO;
  }
  os_unfair_lock_unlock(&_lock);
}

- (void)clear {
  os_unfair_lock_lock(&_lock);
  _creating = NO;
  _reservation = 0;
  _report = nil;
  _handle = nil;
  _uploading = NO;
  _uploadGeneration += 1;
  if (_uploadGeneration == 0) {
    _uploadGeneration = 1;
  }
  os_unfair_lock_unlock(&_lock);
}

@end
