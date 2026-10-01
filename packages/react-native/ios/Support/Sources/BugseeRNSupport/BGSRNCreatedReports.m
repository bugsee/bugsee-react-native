#import "BGSRNCreatedReports.h"

#import <os/lock.h>

@implementation BGSRNCreatedReports {
  os_unfair_lock _lock;
  /// Set by `reserve`, cleared by a nil `fulfil`, `take` or `clear`.
  BOOL _reserved;
  NSString *_handle;
  BugseeExtendedReport *_report;
  NSUInteger _next;
}

- (instancetype)init {
  if ((self = [super init])) {
    _lock = OS_UNFAIR_LOCK_INIT;
    _next = 1;
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

- (BOOL)reserve {
  os_unfair_lock_lock(&_lock);
  const BOOL admitted = !_reserved;
  if (admitted) {
    _reserved = YES;
  }
  os_unfair_lock_unlock(&_lock);
  return admitted;
}

- (nullable NSString *)fulfil:(nullable BugseeExtendedReport *)report {
  os_unfair_lock_lock(&_lock);
  NSString *handle = nil;
  // A clear that won the race (reload) must not be undone by a late report.
  if (_reserved) {
    if (report == nil) {
      _reserved = NO;
      _handle = nil;
      _report = nil;
    } else if (_handle == nil) {
      handle = [NSString stringWithFormat:@"cr-%lu", (unsigned long)_next];
      _next += 1;
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
    _reserved = NO;
  }
  os_unfair_lock_unlock(&_lock);
  return report;
}

- (void)clear {
  os_unfair_lock_lock(&_lock);
  _report = nil;
  _handle = nil;
  _reserved = NO;
  os_unfair_lock_unlock(&_lock);
}

@end
