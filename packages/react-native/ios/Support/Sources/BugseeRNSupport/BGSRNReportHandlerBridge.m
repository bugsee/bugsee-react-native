#import "BGSRNReportHandlerBridge.h"

#import <os/lock.h>

#import "BGSRNReportDeadlines.h"

/// One dispatch that reached JS. `done`, `timer`, `report` and `completion`
/// are guarded by the bridge's lock; everything else is immutable.
@interface BGSRNReportHandle : NSObject
@property (nonatomic, copy, readonly) NSString *handleId;
/// Nilled by `finish:`, with `completion`: the deadline task captures the
/// handle, and a cancelled `dispatch_block` keeps its captures until its fire
/// time, so a finished handle would otherwise pin both for up to 25 s.
@property (nonatomic, strong, nullable) id<BGSReportContract> report;
@property (nonatomic, copy, nullable) BGSCallback completion;
/// The sink this handle was emitted to; its detach completes it. Weak, like
/// the sink itself: the bridge must not keep a torn-down module alive.
@property (nonatomic, weak, readonly) id owner;
/// The exactly-once guard. Whoever flips it runs the completion.
@property (nonatomic) BOOL done;
@property (nonatomic, strong, nullable) id timer;
@end

@implementation BGSRNReportHandle

- (instancetype)initWithId:(NSString *)handleId
                    report:(id<BGSReportContract>)report
                completion:(BGSCallback)completion
                     owner:(id)owner {
  self = [super init];
  if (self) {
    _handleId = [handleId copy];
    _report = report;
    _completion = [completion copy];
    _owner = owner;
  }
  return self;
}

@end

static NSString *PhaseWire(BGSRNReportPhase phase) {
  return phase == BGSRNReportPhaseBefore ? @"before" : @"after";
}

/// The SDK's own fault must not escape into JS's queue or the timer's.
static void RunQuietly(BGSCallback _Nullable completion) {
  if (completion == nil) {
    return;
  }
  @try {
    completion();
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN report handler completion threw: %@", exception);
  }
}

static NSString *_Nullable SafeReportId(id<BGSReportContract> report) {
  @try {
    return report.reportId;
  } @catch (NSException *exception) {
    return nil;
  }
}

static NSString *_Nullable SafeType(id<BGSReportContract> report) {
  @try {
    return report.type;
  } @catch (NSException *exception) {
    return nil;
  }
}

@implementation BGSRNReportHandlerBridge {
  BGSRNReportScheduler _schedule;
  BGSRNReportSchedulerCancel _cancel;
  BGSRNReportOutcomeLog _log;

  /// Guards everything below. The SDK dispatches on main (live) or its own
  /// threads (recovery), JS completes and reads on the module's queue, and
  /// deadlines fire on the scheduler's: all of them meet here. Never held
  /// while calling out -- not the SDK's completion, not the sink, not the
  /// scheduler.
  os_unfair_lock _lock;
  __weak id _sink;
  BGSRNReportRequestBlock _block;
  BOOL _beforeRegistered;
  BOOL _afterRegistered;
  NSMutableDictionary<NSString *, BGSRNReportHandle *> *_handles;
  uint64_t _counter;
}

+ (BGSRNReportHandlerBridge *)shared {
  static BGSRNReportHandlerBridge *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // One serial queue for every handle's deadline. A cancelled block that has
    // not started never runs; one that has already started still reaches the
    // handle's guard, which is what makes cancelling safe to race.
    dispatch_queue_t queue = dispatch_queue_create("com.bugsee.reactnative.report-deadline",
                                                   DISPATCH_QUEUE_SERIAL);
    shared = [[BGSRNReportHandlerBridge alloc]
        initWithScheduler:^id(dispatch_block_t task, int64_t delayMs) {
          dispatch_block_t block = dispatch_block_create(0, task);
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * (int64_t)NSEC_PER_MSEC), queue, block);
          return block;
        }
        cancel:^(id token) {
          dispatch_block_cancel((dispatch_block_t)token);
        }];
  });
  return shared;
}

- (instancetype)initWithScheduler:(BGSRNReportScheduler)schedule cancel:(BGSRNReportSchedulerCancel)cancel {
  return [self initWithScheduler:schedule
                          cancel:cancel
                             log:^(NSString *line) {
                               // NSLog, not os_log: it reaches the
                               // `devicectl --console` stream the device
                               // tests match.
                               NSLog(@"%@", line);
                             }];
}

- (instancetype)initWithScheduler:(BGSRNReportScheduler)schedule
                           cancel:(BGSRNReportSchedulerCancel)cancel
                              log:(BGSRNReportOutcomeLog)log {
  self = [super init];
  if (self) {
    _schedule = [schedule copy];
    _cancel = [cancel copy];
    _log = [log copy];
    _lock = OS_UNFAIR_LOCK_INIT;
    _handles = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)setPhasesBefore:(BOOL)before after:(BOOL)after {
  os_unfair_lock_lock(&_lock);
  _beforeRegistered = before;
  _afterRegistered = after;
  os_unfair_lock_unlock(&_lock);
}

- (void)attach:(id)sink block:(BGSRNReportRequestBlock)block {
  os_unfair_lock_lock(&_lock);
  _sink = sink;
  _block = [block copy];
  _beforeRegistered = NO;
  _afterRegistered = NO;
  os_unfair_lock_unlock(&_lock);
}

- (void)detach:(id)sink {
  NSMutableArray<BGSRNReportHandle *> *stale = [NSMutableArray array];
  os_unfair_lock_lock(&_lock);
  if (_sink == sink) {
    _sink = nil;
    _block = nil;
    _beforeRegistered = NO;
    _afterRegistered = NO;
  }
  for (BGSRNReportHandle *handle in _handles.allValues) {
    if (handle.owner == sink) {
      [stale addObject:handle];
    }
  }
  os_unfair_lock_unlock(&_lock);

  for (BGSRNReportHandle *handle in stale) {
    [self finish:handle by:@"detach"];
  }
}

- (void)dispatchPhase:(BGSRNReportPhase)phase
               report:(id<BGSReportContract>)report
        isTerminating:(BOOL)isTerminating
         onMainThread:(BOOL)onMain
           completion:(BGSCallback)completion {
  // The process dies when this returns; nothing asynchronous survives it.
  // Never YES on iOS today, but the contract allows it.
  if (isTerminating) {
    [self completeUnmintedPhase:phase report:report completion:completion by:@"terminating"];
    return;
  }

  os_unfair_lock_lock(&_lock);
  id target = _sink;
  BGSRNReportRequestBlock block = _block;
  const BOOL registered = phase == BGSRNReportPhaseBefore ? _beforeRegistered : _afterRegistered;
  BGSRNReportHandle *handle = nil;
  if (target != nil && block != nil && registered) {
    NSString *handleId = [NSString stringWithFormat:@"rh-%llu", ++_counter];
    handle = [[BGSRNReportHandle alloc] initWithId:handleId report:report completion:completion owner:target];
    _handles[handleId] = handle;
  }
  os_unfair_lock_unlock(&_lock);

  if (handle == nil) {
    [self completeUnmintedPhase:phase report:report completion:completion by:@"no-handler"];
    return;
  }

  // Live (main) or recovery (off main): see BGSRNReportDeadlines.h. Unlike
  // Android, recovery still reaches JS.
  const int64_t deadlineMs = BGSRNDeadlineMs(onMain);
  // The task holds the handle itself, not its id: a deadline that was already
  // running when JS completed must still hit the guard.
  id timer = _schedule(^{
    [self finish:handle by:@"deadline"];
  }, deadlineMs);
  os_unfair_lock_lock(&_lock);
  const BOOL alreadyDone = handle.done;
  if (!alreadyDone) {
    handle.timer = timer;
  }
  os_unfair_lock_unlock(&_lock);
  if (alreadyDone) {
    // Finished between minting and here; don't leave the timer armed.
    [self cancelQuietly:timer];
  }

  _log([NSString stringWithFormat:@"BugseeRN report handler %@ phase=%@ deadline=%lld",
                                  handle.handleId, PhaseWire(phase), deadlineMs]);
  // Branch on the result, never @try: the sink catches inside Objective-C++
  // (BGSRNGuardedEmit), and nothing may unwind through this ARC file, which
  // is not built exception-safe.
  const BOOL delivered = block(@{
    @"handleId" : handle.handleId,
    @"phase" : PhaseWire(phase),
    @"reportId" : SafeReportId(report) ?: @"",
    @"type" : SafeType(report) ?: @"",
    @"deadlineMs" : @((double)deadlineMs),
  });
  if (!delivered) {
    // A dead bridge, on the SDK's thread. JS will never answer, so answer for
    // it now.
    NSLog(@"BugseeRN report handler %@ could not reach JS", handle.handleId);
    [self finish:handle by:@"no-handler"];
  }
}

- (BOOL)complete:(NSString *)handleId {
  os_unfair_lock_lock(&_lock);
  BGSRNReportHandle *handle = _handles[handleId];
  os_unfair_lock_unlock(&_lock);
  return handle != nil && [self finish:handle by:@"js"];
}

- (id<BGSReportContract>)reportFor:(NSString *)handleId {
  os_unfair_lock_lock(&_lock);
  BGSRNReportHandle *handle = _handles[handleId];
  id<BGSReportContract> report = (handle == nil || handle.done) ? nil : handle.report;
  os_unfair_lock_unlock(&_lock);
  return report;
}

#pragma mark - Private

/// @return YES only for the call that ran the SDK completion.
- (BOOL)finish:(BGSRNReportHandle *)handle by:(NSString *)by {
  os_unfair_lock_lock(&_lock);
  if (handle.done) {
    os_unfair_lock_unlock(&_lock);
    return NO;
  }
  handle.done = YES;
  if (_handles[handle.handleId] == handle) {
    [_handles removeObjectForKey:handle.handleId];
  }
  id timer = handle.timer;
  handle.timer = nil;
  BGSCallback completion = handle.completion;
  handle.completion = nil;
  handle.report = nil;
  os_unfair_lock_unlock(&_lock);

  // Outside the lock from here: the completion re-enters the SDK, and a
  // cancel or a log line has no business holding up every other handle.
  if (timer != nil) {
    [self cancelQuietly:timer];
  }
  _log([NSString stringWithFormat:@"BugseeRN report handler %@ completed by=%@", handle.handleId, by]);
  RunQuietly(completion);
  return YES;
}

/// No handle was minted; the line still carries the report for correlation.
- (void)completeUnmintedPhase:(BGSRNReportPhase)phase
                       report:(id<BGSReportContract>)report
                   completion:(BGSCallback)completion
                           by:(NSString *)by {
  _log([NSString stringWithFormat:@"BugseeRN report handler - completed by=%@ phase=%@ report=%@",
                                  by, PhaseWire(phase), SafeReportId(report)]);
  RunQuietly(completion);
}

- (void)cancelQuietly:(id)timer {
  @try {
    _cancel(timer);
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN report handler timer cancel threw: %@", exception);
  }
}

@end
