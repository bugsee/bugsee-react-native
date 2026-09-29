#import "BGSRNDataRequestBridge.h"

#import <UIKit/UIKit.h>
#import <os/lock.h>
#import <time.h>

NSString *const BGSRNDataRequestTypeViewHierarchy = @"vh";
const int64_t BGSRNDataRequestDeadlineMs = 450;

/// One request that reached the table. `done`, `timer` and `reply` are
/// guarded by the bridge's lock; everything else is immutable.
@interface BGSRNDataRequest : NSObject
@property (nonatomic, copy, readonly) NSString *requestId;
/// Nilled by `finish:`: the deadline task captures the request, and a
/// cancelled `dispatch_block` keeps its captures until its fire time.
@property (nonatomic, copy, nullable) BGSRNDataRequestReply reply;
/// The sink this request was emitted to; its detach answers it. Weak, like the
/// sink itself: the bridge must not keep a torn-down module alive.
@property (nonatomic, weak, readonly) id owner;
/// Taken on entry to `requestType:reply:`, before any check.
@property (nonatomic, readonly) int64_t startMs;
/// The exactly-once guard. Whoever flips it runs the reply.
@property (nonatomic) BOOL done;
@property (nonatomic, strong, nullable) id timer;
@end

@implementation BGSRNDataRequest

- (instancetype)initWithId:(NSString *)requestId
                     reply:(BGSRNDataRequestReply)reply
                     owner:(id)owner
                   startMs:(int64_t)startMs {
  self = [super init];
  if (self) {
    _requestId = [requestId copy];
    _reply = [reply copy];
    _owner = owner;
    _startMs = startMs;
  }
  return self;
}

@end

/// The SDK's own fault must not escape into JS's queue, the timer's, or back
/// into the SDK's main-thread pass.
static void RunQuietly(BGSRNDataRequestReply _Nullable reply, NSString *_Nullable payload) {
  if (reply == nil) {
    return;
  }
  @try {
    reply(payload);
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN data request reply threw: %@", exception);
  }
}

/// `bytes=` in the completed line: the payload's UTF-8 byte count, as on
/// Android -- never its UTF-16 length, so both platforms' lines compare.
static NSString *BytesOf(NSString *_Nullable payload) {
  if (payload == nil) {
    return @"null";
  }
  return [NSString stringWithFormat:@"%lu",
                                    (unsigned long)[payload lengthOfBytesUsingEncoding:NSUTF8StringEncoding]];
}

/// A point, if `value` is an `NSValue` holding a finite `CGPoint`. The block
/// is the module's, but a bad origin would put every node in the wrong place,
/// and there is no better answer than none.
static BOOL PointFrom(id _Nullable value, CGPoint *point) {
  if (![value isKindOfClass:NSValue.class] || strcmp([(NSValue *)value objCType], @encode(CGPoint)) != 0) {
    return NO;
  }
  const CGPoint p = [(NSValue *)value CGPointValue];
  if (!isfinite(p.x) || !isfinite(p.y)) {
    return NO;
  }
  // `+ 0.0` turns a -0 into 0, so the line never reads `origin=-0,0`.
  *point = CGPointMake(p.x + 0.0, p.y + 0.0);
  return YES;
}

/// The origin block's value; `*threw` says the block raised, which is the
/// bridge failing rather than there being no origin.
static id _Nullable CallOrigin(BGSRNDataRequestOriginBlock _Nullable block, BOOL *threw) {
  *threw = NO;
  if (block == nil) {
    return nil;
  }
  @try {
    return block();
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN data request origin threw: %@", exception);
    *threw = YES;
    return nil;
  }
}

@implementation BGSRNDataRequestBridge {
  BGSRNDataRequestScheduler _schedule;
  BGSRNDataRequestSchedulerCancel _cancel;
  BGSRNDataRequestClock _clock;
  BGSRNDataRequestOutcomeLog _log;

  /// Guards everything below. The SDK requests on main, JS completes on the
  /// module's method queue, deadlines fire on the scheduler's, and a reload
  /// attaches and detaches wherever React Native tears down: all of them meet
  /// here. Never held while calling out -- not the reply, not the sink, not
  /// the origin, not the scheduler, not the log.
  os_unfair_lock _lock;
  __weak id _sink;
  BGSRNDataRequestSinkBlock _block;
  BGSRNDataRequestOriginBlock _origin;
  BOOL _viewTreeEnabled;
  NSMutableDictionary<NSString *, BGSRNDataRequest *> *_requests;
  uint64_t _counter;
}

+ (BGSRNDataRequestBridge *)shared {
  static BGSRNDataRequestBridge *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // One serial queue for every request's deadline, off main: the SDK's own
    // timeout runs off main too, so a busy main thread cannot hold back the
    // answer. A cancelled block that has not started never runs; one that has
    // already started still reaches the request's guard, which is what makes
    // cancelling safe to race.
    dispatch_queue_t queue = dispatch_queue_create("com.bugsee.reactnative.data-request-deadline",
                                                   DISPATCH_QUEUE_SERIAL);
    shared = [[BGSRNDataRequestBridge alloc]
        initWithScheduler:^id(dispatch_block_t task, int64_t delayMs) {
          dispatch_block_t block = dispatch_block_create(0, task);
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * (int64_t)NSEC_PER_MSEC), queue, block);
          return block;
        }
        cancel:^(id token) {
          dispatch_block_cancel((dispatch_block_t)token);
        }
        clock:^int64_t {
          // Monotonic, and unaffected by the wall clock being set.
          return (int64_t)(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / NSEC_PER_MSEC);
        }];
  });
  return shared;
}

- (instancetype)initWithScheduler:(BGSRNDataRequestScheduler)schedule
                           cancel:(BGSRNDataRequestSchedulerCancel)cancel
                            clock:(BGSRNDataRequestClock)nowMs {
  return [self initWithScheduler:schedule
                          cancel:cancel
                           clock:nowMs
                             log:^(NSString *line) {
                               // NSLog, not os_log: it reaches the console
                               // stream the device tests match.
                               NSLog(@"%@", line);
                             }];
}

- (instancetype)initWithScheduler:(BGSRNDataRequestScheduler)schedule
                           cancel:(BGSRNDataRequestSchedulerCancel)cancel
                            clock:(BGSRNDataRequestClock)nowMs
                              log:(BGSRNDataRequestOutcomeLog)log {
  self = [super init];
  if (self) {
    _schedule = [schedule copy];
    _cancel = [cancel copy];
    _clock = [nowMs copy];
    _log = [log copy];
    _lock = OS_UNFAIR_LOCK_INIT;
    _requests = [NSMutableDictionary dictionary];
  }
  return self;
}

- (BOOL)viewTreeEnabled {
  os_unfair_lock_lock(&_lock);
  const BOOL enabled = _viewTreeEnabled;
  os_unfair_lock_unlock(&_lock);
  return enabled;
}

- (void)setViewTreeEnabled:(BOOL)viewTreeEnabled {
  os_unfair_lock_lock(&_lock);
  _viewTreeEnabled = viewTreeEnabled;
  os_unfair_lock_unlock(&_lock);
}

- (NSUInteger)outstanding {
  os_unfair_lock_lock(&_lock);
  const NSUInteger count = _requests.count;
  os_unfair_lock_unlock(&_lock);
  return count;
}

- (void)attach:(id)sink block:(BGSRNDataRequestSinkBlock)block origin:(BGSRNDataRequestOriginBlock)origin {
  os_unfair_lock_lock(&_lock);
  _sink = sink;
  _block = [block copy];
  _origin = [origin copy];
  _viewTreeEnabled = NO;
  os_unfair_lock_unlock(&_lock);
}

- (void)detach:(id)sink {
  NSMutableArray<BGSRNDataRequest *> *stale = [NSMutableArray array];
  os_unfair_lock_lock(&_lock);
  if (_sink == sink) {
    _sink = nil;
    _block = nil;
    _origin = nil;
    _viewTreeEnabled = NO;
  }
  for (BGSRNDataRequest *request in _requests.allValues) {
    if (request.owner == sink) {
      [stale addObject:request];
    }
  }
  os_unfair_lock_unlock(&_lock);

  for (BGSRNDataRequest *request in stale) {
    [self finish:request payload:nil by:@"detach"];
  }
}

- (void)requestType:(NSString *)type reply:(BGSRNDataRequestReply)reply {
  // First: the plan's `ms` is measured from the moment requestData was
  // entered, not from whenever a request happens to be minted.
  const int64_t start = _clock();

  os_unfair_lock_lock(&_lock);
  // Minted for every call, answered or not, so an id is never reused and
  // every outcome line can be told apart.
  NSString *requestId = [NSString stringWithFormat:@"dr-%llu", ++_counter];
  id target = _sink;
  BGSRNDataRequestSinkBlock block = _block;
  BGSRNDataRequestOriginBlock originBlock = _origin;
  const BOOL enabled = _viewTreeEnabled;
  os_unfair_lock_unlock(&_lock);

  if (![type isKindOfClass:NSString.class] || ![type isEqualToString:BGSRNDataRequestTypeViewHierarchy]) {
    [self answerUnminted:requestId reply:reply startMs:start by:@"unknown-type"];
    return;
  }
  if (target == nil || block == nil || !enabled) {
    [self answerUnminted:requestId reply:reply startMs:start by:@"no-js"];
    return;
  }
  // Outside the lock: the module's block reads UIKit, on this (main) thread.
  BOOL originThrew = NO;
  id originValue = CallOrigin(originBlock, &originThrew);
  if (originThrew) {
    [self answerUnminted:requestId reply:reply startMs:start by:@"failed"];
    return;
  }
  CGPoint origin = CGPointZero;
  if (!PointFrom(originValue, &origin)) {
    [self answerUnminted:requestId reply:reply startMs:start by:@"no-origin"];
    return;
  }

  BGSRNDataRequest *request = [[BGSRNDataRequest alloc] initWithId:requestId
                                                             reply:reply
                                                             owner:target
                                                           startMs:start];
  os_unfair_lock_lock(&_lock);
  // Checked and inserted under one hold: a detach that ran after the sink was
  // read above has either already cleared it (and this answers now) or will
  // find this request in the table and answer it.
  const BOOL stillAttached = _sink == target;
  if (stillAttached) {
    _requests[requestId] = request;
  }
  os_unfair_lock_unlock(&_lock);
  if (!stillAttached) {
    [self answerUnminted:requestId reply:reply startMs:start by:@"detach"];
    return;
  }

  // The task holds the request itself, not its id: a deadline that was
  // already running when JS completed must still hit the guard.
  id timer = [self scheduleQuietly:^{
    [self finish:request payload:nil by:@"deadline"];
  }];
  if (timer == nil) {
    // Registered, but nothing will ever time it out: answer now rather than
    // leave the SDK to its own timeout, and leave nothing in the table for a
    // later detach to answer a second time.
    [self finish:request payload:nil by:@"failed"];
    return;
  }
  os_unfair_lock_lock(&_lock);
  const BOOL alreadyDone = request.done;
  if (!alreadyDone) {
    request.timer = timer;
  }
  os_unfair_lock_unlock(&_lock);
  if (alreadyDone) {
    // Finished between minting and here; don't leave the timer armed.
    [self cancelQuietly:timer];
  }

  _log([NSString stringWithFormat:@"BugseeRN data request %@ type=%@ origin=%g,%g", requestId, type,
                                  (double)origin.x, (double)origin.y]);
  // Branch on the result, never @try: the sink catches inside Objective-C++
  // (BGSRNGuardedEmit), and nothing may unwind through this ARC file, which
  // is not built exception-safe.
  const BOOL delivered = block(@{
    @"requestId" : requestId,
    @"type" : type,
    @"originX" : @((double)origin.x),
    @"originY" : @((double)origin.y),
  });
  if (!delivered) {
    // A dead bridge, on the SDK's thread. JS will never answer, so answer for
    // it now rather than let the SDK wait out the deadline.
    [self finish:request payload:nil by:@"sink-threw"];
  }
}

- (BOOL)complete:(NSString *)requestId payload:(NSString *)payload {
  if (![requestId isKindOfClass:NSString.class]) {
    return NO;
  }
  os_unfair_lock_lock(&_lock);
  BGSRNDataRequest *request = _requests[requestId];
  os_unfair_lock_unlock(&_lock);
  NSString *data = [payload isKindOfClass:NSString.class] ? payload : nil;
  return request != nil && [self finish:request payload:data by:@"js"];
}

#pragma mark - Private

/// @return YES only for the call that ran the reply.
- (BOOL)finish:(BGSRNDataRequest *)request payload:(NSString *_Nullable)payload by:(NSString *)by {
  os_unfair_lock_lock(&_lock);
  if (request.done) {
    os_unfair_lock_unlock(&_lock);
    return NO;
  }
  request.done = YES;
  if (_requests[request.requestId] == request) {
    [_requests removeObjectForKey:request.requestId];
  }
  id timer = request.timer;
  request.timer = nil;
  BGSRNDataRequestReply reply = request.reply;
  request.reply = nil;
  os_unfair_lock_unlock(&_lock);

  // Outside the lock from here: the reply re-enters the SDK, and a cancel or
  // a log line has no business holding up every other request.
  if (timer != nil) {
    [self cancelQuietly:timer];
  }
  RunQuietly(reply, payload);
  [self logCompleted:request.requestId by:by payload:payload startMs:request.startMs];
  return YES;
}

/// No request was minted into the table; the line still names the outcome.
- (void)answerUnminted:(NSString *)requestId
                 reply:(BGSRNDataRequestReply)reply
               startMs:(int64_t)startMs
                    by:(NSString *)by {
  RunQuietly(reply, nil);
  [self logCompleted:requestId by:by payload:nil startMs:startMs];
}

/// `data request <id> completed by=<...> bytes=<n|null> ms=<elapsed>`,
/// verbatim from the plan's Phase 6 "Log lines".
- (void)logCompleted:(NSString *)requestId by:(NSString *)by payload:(NSString *_Nullable)payload startMs:(int64_t)startMs {
  _log([NSString stringWithFormat:@"BugseeRN data request %@ completed by=%@ bytes=%@ ms=%lld", requestId, by,
                                  BytesOf(payload), _clock() - startMs]);
}

/// The deadline's token, or nil if the scheduler threw or armed nothing.
- (nullable id)scheduleQuietly:(dispatch_block_t)task {
  @try {
    return _schedule(task, BGSRNDataRequestDeadlineMs);
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN data request deadline could not be armed: %@", exception);
    return nil;
  }
}

- (void)cancelQuietly:(id)timer {
  @try {
    _cancel(timer);
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN data request timer cancel threw: %@", exception);
  }
}

@end
