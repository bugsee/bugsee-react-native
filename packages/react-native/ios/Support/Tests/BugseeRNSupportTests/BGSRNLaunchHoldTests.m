@import XCTest;
@import BugseeRNSupport;

/// Pins `BGSRNLaunchHold`, the WORKAROUND for bugsee-cocoa#227: beta5 drops a
/// report-creating call made while the SDK is Launching, and `launch()`
/// resolves before Launched. Calls made then are held and replayed in order
/// on Launched; a launch that does not complete settles them as dropped.
/// Every test runs on main, where the hold lives.
@interface BGSRNLaunchHoldTests : XCTestCase
@end

@implementation BGSRNLaunchHoldTests {
  BugseeStatus _status;
  NSMutableArray<NSString *> *_runs;
}

- (void)setUp {
  [super setUp];
  _status = BugseeStatusLaunching;
  _runs = [NSMutableArray array];
}

- (BGSRNLaunchHold *)holdWithCapacity:(NSUInteger)capacity deadlineMs:(int64_t)deadlineMs {
  __weak __typeof(self) weakSelf = self;
  return [[BGSRNLaunchHold alloc] initWithCapacity:capacity
                                        deadlineMs:deadlineMs
                                            status:^BugseeStatus {
                                              __typeof(self) strongSelf = weakSelf;
                                              return strongSelf != nil ? strongSelf->_status : BugseeStatusStopped;
                                            }];
}

- (BGSRNGatedCall)recorder:(NSString *)name {
  NSMutableArray<NSString *> *runs = _runs;
  return ^(BGSRNGatedRun run) {
    NSString *how = run == BGSRNGatedRunNow ? @"now" : run == BGSRNGatedRunReplay ? @"replay" : @"drop";
    [runs addObject:[NSString stringWithFormat:@"%@:%@", name, how]];
  };
}

/// Lets a main-queue hop or a short deadline run. Pumps the main run loop for
/// `seconds` and asserts nothing about timing: a starved runner only makes it
/// return late.
- (void)spinMain:(NSTimeInterval)seconds {
  NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (end.timeIntervalSinceNow > 0) {
    if (![NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:end]) {
      [NSThread sleepForTimeInterval:0.005];
    }
  }
}

/// Pumps main until `done` holds. The generous limit (runner main-queue
/// starvation) is only a backstop; the wait asserts nothing about timing.
- (void)spinMainUntil:(BOOL (^)(void))done {
  NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:30];
  while (!done() && limit.timeIntervalSinceNow > 0) {
    [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode
                        beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  XCTAssertTrue(done(), @"main never reached the expected state");
}

- (void)testTheSharedHoldHasTheDocumentedBounds {
  XCTAssertEqual(BGSRNLaunchHoldCapacity, 64u);
  XCTAssertEqual(BGSRNLaunchHoldDeadlineMs, 30000);
  XCTAssertNotNil(BGSRNLaunchHold.shared);
  XCTAssertEqual(BGSRNLaunchHold.shared, BGSRNLaunchHold.shared);
}

- (void)testACallWhileLaunchingIsHeldNotRun {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
  [hold submit:@"a" call:[self recorder:@"a"]];
  XCTAssertEqualObjects(_runs, @[]);
  XCTAssertEqual(hold.heldCount, 1u);
}

- (void)testLaunchedReplaysHeldCallsInOrder {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
  [hold submit:@"a" call:[self recorder:@"a"]];
  [hold submit:@"b" call:[self recorder:@"b"]];
  [hold submit:@"c" call:[self recorder:@"c"]];
  _status = BugseeStatusLaunched;
  [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
  NSArray *expected = @[ @"a:replay", @"b:replay", @"c:replay" ];
  XCTAssertEqualObjects(_runs, expected);
  XCTAssertEqual(hold.heldCount, 0u);
  // Once only: a second Launched has nothing left to replay.
  [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
  XCTAssertEqualObjects(_runs, expected);
}

/// The SDK delivers the event on its own queue; the hold hops to main.
- (void)testLaunchedFromAnotherThreadReplaysOnMain {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
  __block BOOL onMain = NO;
  [hold submit:@"a" call:^(BGSRNGatedRun run) {
    onMain = NSThread.isMainThread;
  }];
  _status = BugseeStatusLaunched;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
  });
  [self spinMain:0.2];
  XCTAssertTrue(onMain);
  XCTAssertEqual(hold.heldCount, 0u);
}

/// Launched can be visible before its event arrives: a new call then runs
/// after the held ones, never ahead of them.
- (void)testACallAfterLaunchedRunsBehindTheHeldOnes {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
  [hold submit:@"a" call:[self recorder:@"a"]];
  _status = BugseeStatusLaunched;
  [hold submit:@"b" call:[self recorder:@"b"]];
  XCTAssertEqualObjects(_runs, (@[ @"a:replay", @"b:now" ]));
  XCTAssertEqual(hold.heldCount, 0u);
}

/// Unchanged behaviour: with nothing held, a call runs at once whatever the
/// status -- after Launched, and before launch() (where the SDK drops it).
- (void)testNothingIsHeldOutsideLaunching {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
  _status = BugseeStatusLaunched;
  [hold submit:@"a" call:[self recorder:@"a"]];
  _status = BugseeStatusStopped;
  [hold submit:@"b" call:[self recorder:@"b"]];
  _status = BugseeStatusStopping;
  [hold submit:@"c" call:[self recorder:@"c"]];
  XCTAssertEqualObjects(_runs, (@[ @"a:now", @"b:now", @"c:now" ]));
  XCTAssertEqual(hold.heldCount, 0u);
}

- (void)testTheCapDropsTheCallThatWouldExceedIt {
  BGSRNLaunchHold *hold = [self holdWithCapacity:2 deadlineMs:0];
  [hold submit:@"a" call:[self recorder:@"a"]];
  [hold submit:@"b" call:[self recorder:@"b"]];
  [hold submit:@"c" call:[self recorder:@"c"]];
  XCTAssertEqualObjects(_runs, @[ @"c:drop" ]);
  XCTAssertEqual(hold.heldCount, 2u);
  _status = BugseeStatusLaunched;
  [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
  XCTAssertEqualObjects(_runs, (@[ @"c:drop", @"a:replay", @"b:replay" ]));
}

/// A stop overtaking the launch: the SDK never reaches Launched, so the held
/// calls settle as dropped calls do, and are not replayed later.
- (void)testAStopDropsTheHeldCalls {
  for (NSString *event in @[ @"com.bugsee.lifecycle.Stopping", @"com.bugsee.lifecycle.Stopped" ]) {
    [_runs removeAllObjects];
    _status = BugseeStatusLaunching;
    BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
    [hold submit:@"a" call:[self recorder:@"a"]];
    [hold submit:@"b" call:[self recorder:@"b"]];
    _status = [event hasSuffix:@"Stopping"] ? BugseeStatusStopping : BugseeStatusStopped;
    [hold lifecycleEvent:event];
    XCTAssertEqualObjects(_runs, (@[ @"a:drop", @"b:drop" ]), @"%@", event);
    XCTAssertEqual(hold.heldCount, 0u);
    _status = BugseeStatusLaunched;
    [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
    XCTAssertEqualObjects(_runs, (@[ @"a:drop", @"b:drop" ]), @"%@", event);
  }
}

/// A Launched from an earlier launch, arriving after a stop and a relaunch,
/// must not release the new launch's calls, and unrelated events do nothing.
- (void)testOnlyALaunchedStatusReleases {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:0];
  [hold submit:@"a" call:[self recorder:@"a"]];
  [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
  [hold lifecycleEvent:@"com.bugsee.lifecycle.BlackoutStarted"];
  [hold lifecycleEvent:@"com.bugsee.lifecycle.Launching"];
  XCTAssertEqualObjects(_runs, @[]);
  XCTAssertEqual(hold.heldCount, 1u);
}

/// A launch that never completes: the deadline settles the held calls as
/// dropped, so no promise stays pending for good.
- (void)testTheDeadlineDropsCallsStillHeld {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:50];
  [hold submit:@"a" call:[self recorder:@"a"]];
  [hold submit:@"b" call:[self recorder:@"b"]];
  [self spinMain:0.3];
  XCTAssertEqualObjects(_runs, (@[ @"a:drop", @"b:drop" ]));
  XCTAssertEqual(hold.heldCount, 0u);
}

/// A deadline armed for a batch that Launched already released does nothing
/// to the next batch, which gets its own.
///
/// No wall-clock race: the "b is still held" check runs inside a main-queue
/// block due BETWEEN a's stale timer and b's own, so it runs after the former
/// and before the latter whatever the runner does (timers fire in due order).
/// With D = 2 s, t = seconds after a was submitted:
///   a's stale timer due t=2.0 < the check due t=2.5 < b's timer due >= t=3.0
/// (b is submitted no earlier than t=1.0, and its deadline is D after that).
- (void)testAnOldDeadlineDoesNotTouchALaterBatch {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:2000];
  [hold submit:@"a" call:[self recorder:@"a"]];
  _status = BugseeStatusLaunched;
  [hold lifecycleEvent:@"com.bugsee.lifecycle.Launched"];
  _status = BugseeStatusLaunching;
  __block BOOL checked = NO;
  __weak __typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    __typeof(self) strongSelf = weakSelf;
    // a's stale timer has run; b's has not.
    XCTAssertEqualObjects(strongSelf->_runs, @[ @"a:replay" ]);
    XCTAssertEqual(hold.heldCount, 1u);
    checked = YES;
  });
  [self spinMain:1.0];
  [hold submit:@"b" call:[self recorder:@"b"]];
  XCTAssertEqual(hold.heldCount, 1u);
  [self spinMainUntil:^BOOL {
    return checked && hold.heldCount == 0;
  }];
  XCTAssertEqualObjects(_runs, (@[ @"a:replay", @"b:drop" ]));
}

/// At the deadline the status decides: Launched (its event lost) replays.
- (void)testTheDeadlineReplaysWhenTheSDKIsLaunched {
  BGSRNLaunchHold *hold = [self holdWithCapacity:8 deadlineMs:50];
  [hold submit:@"a" call:[self recorder:@"a"]];
  _status = BugseeStatusLaunched;
  [self spinMain:0.3];
  XCTAssertEqualObjects(_runs, @[ @"a:replay" ]);
}

@end
