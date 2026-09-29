@import XCTest;
@import UIKit;
@import BugseeRNSupport;

/// A deadline the test fires by hand; records cancellation.
@interface BGSRNDataRequestManualTask : NSObject
@property (nonatomic, copy) dispatch_block_t block;
@property (nonatomic) int64_t delayMs;
@property (atomic) BOOL cancelled;
@end

@implementation BGSRNDataRequestManualTask
@end

/// A clock the test moves by hand.
@interface BGSRNDataRequestManualClock : NSObject
@property (atomic) int64_t now;
@end

@implementation BGSRNDataRequestManualClock
@end

/// The one property everything here protects: the SDK's callback runs exactly
/// once for every request, whichever of JS, the deadline or a detach gets
/// there first. Running it twice is ignored by the SDK, but never running it
/// costs the SDK its full timeout and, three times in a row, puts the wrapper
/// into the SDK's 50 ms "silent" mode.
///
/// Mirrors Android's `DataRequestBridgeTest` by name. The log lines are the
/// plan's Phase 6 "Log lines", verbatim, behind iOS's `BugseeRN ` prefix.
@interface BGSRNDataRequestBridgeTests : XCTestCase
@end

@implementation BGSRNDataRequestBridgeTests {
  NSMutableArray<BGSRNDataRequestManualTask *> *_tasks;
  NSMutableArray<NSString *> *_lines;
  NSMutableArray<NSDictionary *> *_requests;
  NSMutableArray *_replies;
  BGSRNDataRequestManualClock *_clock;
  BGSRNDataRequestBridge *_bridge;
  NSObject *_sink;
  NSValue *_origin;
}

- (void)setUp {
  [super setUp];
  NSMutableArray<BGSRNDataRequestManualTask *> *tasks = [NSMutableArray array];
  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  BGSRNDataRequestManualClock *clock = [BGSRNDataRequestManualClock new];
  _tasks = tasks;
  _lines = lines;
  _clock = clock;
  _requests = [NSMutableArray array];
  _replies = [NSMutableArray array];
  _bridge = [[BGSRNDataRequestBridge alloc]
      initWithScheduler:^id(dispatch_block_t task, int64_t delayMs) {
        BGSRNDataRequestManualTask *t = [BGSRNDataRequestManualTask new];
        t.block = task;
        t.delayMs = delayMs;
        @synchronized(tasks) {
          [tasks addObject:t];
        }
        return t;
      }
      cancel:^(id token) {
        ((BGSRNDataRequestManualTask *)token).cancelled = YES;
      }
      clock:^int64_t {
        return clock.now;
      }
      log:^(NSString *line) {
        @synchronized(lines) {
          [lines addObject:line];
        }
      }];
  _sink = [NSObject new];
  _origin = [NSValue valueWithCGPoint:CGPointMake(0, 0)];
}

#pragma mark - Helpers

- (void)attach:(id)sink into:(NSMutableArray<NSDictionary *> *)requests {
  __weak __typeof(self) weakSelf = self;
  [_bridge attach:sink
            block:^BOOL(NSDictionary *request) {
              [requests addObject:request];
              return YES;
            }
           origin:^NSValue * {
             __strong __typeof(weakSelf) strongSelf = weakSelf;
             return strongSelf->_origin;
           }];
}

- (void)attachAndEnable {
  [self attach:_sink into:_requests];
  _bridge.viewTreeEnabled = YES;
}

- (void)request:(NSString *)type {
  NSMutableArray *replies = _replies;
  [_bridge requestType:type
                 reply:^(NSString *data) {
                   @synchronized(replies) {
                     [replies addObject:data ?: NSNull.null];
                   }
                 }];
}

- (void)requestVh {
  [self request:BGSRNDataRequestTypeViewHierarchy];
}

- (NSString *)lastId {
  return _requests.lastObject[@"requestId"];
}

- (void)fireDue {
  for (BGSRNDataRequestManualTask *t in [_tasks copy]) {
    if (!t.cancelled) {
      t.block();
    }
  }
}

/// The real race: the deadline has already started when `cancel` arrives, so
/// cancelling does not stop it.
- (void)fireEvenIfCancelled {
  for (BGSRNDataRequestManualTask *t in [_tasks copy]) {
    t.block();
  }
}

#pragma mark - Constants

- (void)testTheTypeMatchesTheSdkConstant {
  // BGSManagedHierarchyDataType, BGSCaptureDataProviderViewHierarchy.m:24
  // (SDK 0d9c9d0a3); `static` there, so pinned by value.
  XCTAssertEqualObjects(BGSRNDataRequestTypeViewHierarchy, @"vh");
}

- (void)testDeadlineIsBelowTheSdkBudget {
  // BGSManagedHierarchyTimeoutMs, BGSCaptureDataProviderViewHierarchy.m:28.
  XCTAssertLessThan(BGSRNDataRequestDeadlineMs, 500);
  XCTAssertEqual(BGSRNDataRequestDeadlineMs, 450);
}

#pragma mark - Synchronous nil answers

- (void)testAnUnknownTypeRepliesNilSynchronously {
  [self attachAndEnable];

  [self request:@"other"];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqual(_requests.count, 0u);
  XCTAssertEqual(_tasks.count, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 completed by=unknown-type bytes=null ms=0" ]));
}

- (void)testNoSinkRepliesNilSynchronously {
  _bridge.viewTreeEnabled = YES;

  [self requestVh];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqual(_tasks.count, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 completed by=no-js bytes=null ms=0" ]));
}

- (void)testADisabledViewTreeRepliesNilSynchronously {
  [self attach:_sink into:_requests];

  [self requestVh];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqual(_requests.count, 0u);
  XCTAssertEqual(_tasks.count, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 completed by=no-js bytes=null ms=0" ]));
}

- (void)testNoOriginRepliesNilSynchronously {
  [self attachAndEnable];
  _origin = nil;

  [self requestVh];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqual(_requests.count, 0u);
  XCTAssertEqual(_tasks.count, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 completed by=no-origin bytes=null ms=0" ]));
}

/// The block is the module's, but the bridge does not trust it to hand back
/// a finite point.
- (void)testAnOriginThatIsNotAFinitePointRepliesNilSynchronously {
  [self attachAndEnable];
  _origin = [NSValue valueWithRange:NSMakeRange(1, 2)];
  [self requestVh];
  _origin = [NSValue valueWithCGPoint:CGPointMake(NAN, 0)];
  [self requestVh];
  _origin = (NSValue *)(id)@"0,0";
  [self requestVh];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null, NSNull.null, NSNull.null ]));
  XCTAssertEqual(_requests.count, 0u);
  XCTAssertEqual(_bridge.outstanding, 0u);
}

#pragma mark - The round trip

- (void)testTheSinkGetsTheOrigin {
  [self attachAndEnable];
  _origin = [NSValue valueWithCGPoint:CGPointMake(12.5, 40)];

  [self requestVh];

  XCTAssertEqualObjects(_requests, (@[ @{
                          @"requestId" : @"dr-1",
                          @"type" : @"vh",
                          @"originX" : @12.5,
                          @"originY" : @40,
                        } ]));
  XCTAssertEqual(_replies.count, 0u);
  XCTAssertEqual(_tasks.count, 1u);
  XCTAssertEqual(_tasks[0].delayMs, BGSRNDataRequestDeadlineMs);
  XCTAssertEqual(_bridge.outstanding, 1u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 type=vh origin=12.5,40" ]));
}

- (void)testCompleteDeliversThePayloadExactlyOnce {
  [self attachAndEnable];
  [self requestVh];
  NSString *requestId = [self lastId];

  XCTAssertTrue([_bridge complete:requestId payload:@"{}"]);
  XCTAssertFalse([_bridge complete:requestId payload:@"{\"again\":1}"]);
  [self fireEvenIfCancelled];
  [_bridge detach:_sink];

  XCTAssertEqualObjects(_replies, (@[ @"{}" ]));
  XCTAssertEqual(_bridge.outstanding, 0u);
  // One outcome, too: a late deadline must not log a second `completed`.
  XCTAssertEqualObjects(_lines, (@[
                          @"BugseeRN data request dr-1 type=vh origin=0,0",
                          @"BugseeRN data request dr-1 completed by=js bytes=2 ms=0",
                        ]));
}

- (void)testASecondCompleteIsANoOp {
  [self attachAndEnable];
  [self requestVh];
  NSString *requestId = [self lastId];
  [_bridge complete:requestId payload:nil];

  XCTAssertFalse([_bridge complete:requestId payload:@"{}"]);
  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
}

- (void)testTheDeadlineRepliesNil {
  [self attachAndEnable];
  [self requestVh];
  _clock.now = 450;

  [self fireDue];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-1 completed by=deadline bytes=null ms=450");
  XCTAssertEqual(_bridge.outstanding, 0u);
}

- (void)testAReplyAfterTheDeadlineIsDropped {
  [self attachAndEnable];
  [self requestVh];
  [self fireDue];

  XCTAssertFalse([_bridge complete:[self lastId] payload:@"{}"]);
  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
}

- (void)testCompletingCancelsTheDeadline {
  [self attachAndEnable];
  [self requestVh];

  [_bridge complete:[self lastId] payload:@"{}"];

  XCTAssertTrue(_tasks[0].cancelled);
}

- (void)testAnUnknownIdIsIgnored {
  [self attachAndEnable];
  [self requestVh];

  XCTAssertFalse([_bridge complete:@"dr-99" payload:@"{}"]);
  XCTAssertFalse([_bridge complete:(NSString *)(id)NSNull.null payload:@"{}"]);
  XCTAssertEqual(_replies.count, 0u);
  XCTAssertEqual(_bridge.outstanding, 1u);
}

/// A dead bridge: the emit could not reach JS, so nothing will answer.
- (void)testASinkThatCannotDeliverRepliesNil {
  [_bridge attach:_sink
            block:^BOOL(NSDictionary *request) {
              return NO;
            }
           origin:^NSValue * {
             return [NSValue valueWithCGPoint:CGPointZero];
           }];
  _bridge.viewTreeEnabled = YES;

  [self requestVh];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-1 completed by=sink-threw bytes=null ms=0");
  XCTAssertTrue(_tasks[0].cancelled);
  XCTAssertEqual(_bridge.outstanding, 0u);
}

/// The reply is the SDK's; its fault must not reach JS's queue or the timer's.
- (void)testAThrowingReplyDoesNotEscape {
  [self attachAndEnable];
  [_bridge requestType:@"vh"
                 reply:^(NSString *data) {
                   [NSException raise:@"SDK" format:@"boom"];
                 }];

  XCTAssertNoThrow([_bridge complete:[self lastId] payload:@"{}"]);
  XCTAssertEqual(_bridge.outstanding, 0u);
  XCTAssertNoThrow([_bridge requestType:@"other"
                                  reply:^(NSString *data) {
                                    [NSException raise:@"SDK" format:@"boom"];
                                  }]);
}

/// `by=failed`: the bridge itself failed after the request was registered.
/// The SDK still gets exactly one nil, and nothing is left for a later detach
/// to answer a second time.
- (void)testASchedulerFailureAfterRegisteringStillRepliesExactlyOnceAndLeavesNothingOutstanding {
  NSMutableArray<NSString *> *lines = _lines;
  _bridge = [[BGSRNDataRequestBridge alloc]
      initWithScheduler:^id(dispatch_block_t task, int64_t delayMs) {
        [NSException raise:@"Scheduler" format:@"rejected"];
        return [NSObject new];
      }
      cancel:^(id token) {
      }
      clock:^int64_t {
        return 0;
      }
      log:^(NSString *line) {
        [lines addObject:line];
      }];
  [self attachAndEnable];

  XCTAssertNoThrow([self requestVh]);
  [_bridge detach:_sink];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqual(_bridge.outstanding, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 completed by=failed bytes=null ms=0" ]));
  XCTAssertEqual(_requests.count, 0u);
}

/// An origin block that raises is the bridge failing, not "no origin".
- (void)testAThrowingOriginRepliesNilAsFailed {
  [_bridge attach:_sink
            block:^BOOL(NSDictionary *request) {
              return YES;
            }
           origin:^NSValue * {
             [NSException raise:@"UIKit" format:@"boom"];
             return nil;
           }];
  _bridge.viewTreeEnabled = YES;

  XCTAssertNoThrow([self requestVh]);

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertEqual(_bridge.outstanding, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN data request dr-1 completed by=failed bytes=null ms=0" ]));
}

#pragma mark - Detach and attach

- (void)testDetachRepliesNilToEverythingOutstandingAndDisables {
  [self attachAndEnable];
  [self requestVh];
  [self requestVh];

  [_bridge detach:_sink];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null, NSNull.null ]));
  XCTAssertTrue(_tasks[0].cancelled);
  XCTAssertTrue(_tasks[1].cancelled);
  XCTAssertEqual(_bridge.outstanding, 0u);
  XCTAssertFalse(_bridge.viewTreeEnabled);
  XCTAssertTrue([_lines containsObject:@"BugseeRN data request dr-1 completed by=detach bytes=null ms=0"]);
  XCTAssertTrue([_lines containsObject:@"BugseeRN data request dr-2 completed by=detach bytes=null ms=0"]);

  // And nothing reaches the detached sink afterwards.
  _bridge.viewTreeEnabled = YES;
  [self requestVh];
  XCTAssertEqual(_requests.count, 2u);
  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-3 completed by=no-js bytes=null ms=0");
}

/// A fast reload attaches the new module before the old one is invalidated.
- (void)testDetachingAStaleSinkLeavesTheCurrentOne {
  NSObject *stale = [NSObject new];
  NSMutableArray<NSDictionary *> *staleRequests = [NSMutableArray array];
  [self attach:stale into:staleRequests];
  _bridge.viewTreeEnabled = YES;
  [self requestVh];
  NSString *staleId = staleRequests.lastObject[@"requestId"];

  [self attachAndEnable];
  [self requestVh];
  [_bridge detach:stale];

  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
  XCTAssertFalse([_bridge complete:staleId payload:@"{}"]);
  XCTAssertTrue(_bridge.viewTreeEnabled);
  XCTAssertEqual(_bridge.outstanding, 1u);
  XCTAssertTrue([_bridge complete:[self lastId] payload:@"{}"]);
  XCTAssertEqualObjects(_replies, (@[ NSNull.null, @"{}" ]));

  [self requestVh];
  XCTAssertEqual(_requests.count, 2u);
}

/// Before the new runtime mounts its anchor there is nothing to walk.
- (void)testAFreshAttachDisablesTheViewTreeEvenBeforeTheOldModuleDetaches {
  [self attachAndEnable];

  [self attach:[NSObject new] into:[NSMutableArray array]];

  XCTAssertFalse(_bridge.viewTreeEnabled);
  [self requestVh];
  XCTAssertEqualObjects(_replies, (@[ NSNull.null ]));
}

#pragma mark - Ids and log lines

- (void)testEachRequestGetsAFreshId {
  [self attachAndEnable];
  [self requestVh];
  [self request:@"other"];
  [self requestVh];

  XCTAssertEqualObjects(_requests[0][@"requestId"], @"dr-1");
  XCTAssertEqualObjects(_requests[1][@"requestId"], @"dr-3");
  XCTAssertTrue([_lines containsObject:@"BugseeRN data request dr-2 completed by=unknown-type bytes=null ms=0"]);

  // Completed ids are never handed out again.
  [_bridge complete:@"dr-1" payload:nil];
  [_bridge complete:@"dr-3" payload:nil];
  [self requestVh];
  XCTAssertEqualObjects(_requests[2][@"requestId"], @"dr-4");
}

- (void)testTheCompletedLineCarriesByBytesAndMs {
  [self attachAndEnable];
  _clock.now = 100;
  [self requestVh];
  _clock.now = 137;

  [_bridge complete:[self lastId] payload:@"abc"];

  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-1 completed by=js bytes=3 ms=37");
}

- (void)testANilPayloadLogsNullBytes {
  [self attachAndEnable];
  [self requestVh];

  [_bridge complete:[self lastId] payload:nil];

  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-1 completed by=js bytes=null ms=0");
}

/// The same definition as Android's, so the two platforms' lines compare.
- (void)testBytesIsTheUtf8ByteCountNotTheCharCount {
  [self attachAndEnable];
  [self requestVh];

  [_bridge complete:[self lastId] payload:@"é"];

  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-1 completed by=js bytes=2 ms=0");
}

/// The plan: `ms` is measured from the moment `requestData` was entered.
- (void)testMsIsMeasuredFromEntryToRequestNotFromWhenTheRequestWasMinted {
  BGSRNDataRequestManualClock *clock = _clock;
  NSMutableArray<NSDictionary *> *requests = _requests;
  [_bridge attach:_sink
            block:^BOOL(NSDictionary *request) {
              [requests addObject:request];
              return YES;
            }
           origin:^NSValue * {
             clock.now += 5;
             return [NSValue valueWithCGPoint:CGPointZero];
           }];
  _bridge.viewTreeEnabled = YES;
  [self requestVh];

  [_bridge complete:[self lastId] payload:nil];

  XCTAssertEqualObjects(_lines.lastObject, @"BugseeRN data request dr-1 completed by=js bytes=null ms=5");
}

- (void)testTheTypeLineComesBeforeTheEmit {
  NSMutableArray<NSString *> *lines = _lines;
  __block NSUInteger linesAtEmit = NSNotFound;
  [_bridge attach:_sink
            block:^BOOL(NSDictionary *request) {
              linesAtEmit = lines.count;
              return YES;
            }
           origin:^NSValue * {
             return [NSValue valueWithCGPoint:CGPointMake(-3, 1.25)];
           }];
  _bridge.viewTreeEnabled = YES;

  [self requestVh];

  XCTAssertEqual(linesAtEmit, 1u);
  XCTAssertEqualObjects(_lines[0], @"BugseeRN data request dr-1 type=vh origin=-3,1.25");
}

#pragma mark - Locking

/// `reply` re-enters the SDK, and must never run under the registry lock:
/// here it waits on another thread that needs the lock. Holding the lock
/// across `reply` deadlocks that wait, which the timeout reports.
- (void)testAReplyMayWaitOnAnotherThreadThatUsesTheBridge {
  [self attachAndEnable];
  [self requestVh];
  NSString *other = [self lastId];
  BGSRNDataRequestBridge *bridge = _bridge;
  __block BOOL timedOut = NO;
  __block BOOL otherDelivered = NO;
  [_bridge requestType:@"vh"
                 reply:^(NSString *data) {
                   dispatch_semaphore_t done = dispatch_semaphore_create(0);
                   dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                     otherDelivered = [bridge complete:other payload:@"{}"];
                     dispatch_semaphore_signal(done);
                   });
                   timedOut = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0;
                 }];

  XCTAssertTrue([_bridge complete:[self lastId] payload:@"{}"]);

  XCTAssertFalse(timedOut, @"reply ran while the registry lock was held");
  XCTAssertTrue(otherDelivered);
  XCTAssertEqualObjects(_replies, (@[ @"{}" ]));
  XCTAssertEqual(_bridge.outstanding, 0u);
}

/// Every path at once, many times: exactly one reply per request.
- (void)testJsTheDeadlineAndADetachRacingStillReplyExactlyOnce {
  for (int round = 0; round < 200; round++) {
    [self setUp];
    [self attachAndEnable];
    [self requestVh];
    NSString *requestId = [self lastId];
    BGSRNDataRequestBridge *bridge = _bridge;
    NSObject *sink = _sink;
    BGSRNDataRequestManualTask *deadline = _tasks[0];
    dispatch_apply(3, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t i) {
      if (i == 0) {
        [bridge complete:requestId payload:@"{}"];
      } else if (i == 1) {
        deadline.block();
      } else {
        [bridge detach:sink];
      }
    });
    XCTAssertEqual(_replies.count, 1u);
    XCTAssertEqual(_bridge.outstanding, 0u);
  }
}

@end
