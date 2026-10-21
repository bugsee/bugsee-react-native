@import XCTest;
@import BugseeRNSupport;

/// Shaped like the module's pending classes: the SDK's decision block, and
/// the wrapper's deadline token.
@interface BGSRNFakePendingFilter : NSObject
@property (nonatomic, copy, nullable) void (^decision)(id _Nullable);
@property (nonatomic, copy, nullable) dispatch_block_t deadline;
@property (nonatomic, strong, nullable) NSNumber *expiresAt;
@end
@implementation BGSRNFakePendingFilter
@end

/// The wrapper's own deadline for a filter JS never answers. The SDK has none
/// on iOS, so without it a hung callback keeps its request, and the event the
/// request retains, until the process dies.
@interface BGSRNFilterDeadlineTests : XCTestCase
@property (nonatomic, strong) NSMutableDictionary<NSString *, id> *table;
@property (nonatomic, strong) id lock;
@property (nonatomic, strong) NSMutableArray *answers;
@end

@implementation BGSRNFilterDeadlineTests

- (void)setUp {
  self.table = [NSMutableDictionary dictionary];
  self.lock = [NSObject new];
  self.answers = [NSMutableArray array];
}

/// Pending item whose decision records what it was answered with. `NSNull`
/// stands for nil, so a drop and a keep can be told apart.
- (BGSRNFakePendingFilter *)addPending:(NSString *)requestId {
  BGSRNFakePendingFilter *item = [BGSRNFakePendingFilter new];
  __weak typeof(self) weakSelf = self;
  item.decision = ^(id value) {
    [weakSelf.answers addObject:value ?: [NSNull null]];
  };
  self.table[requestId] = item;
  return item;
}

/// Same number as Android's log and network bridges.
- (void)testTheDeadlineIsNineSeconds {
  XCTAssertEqual(BGSRNFilterDeadlineMs, 9000);
}

- (void)testArmedBlockRunsOnTheQueueOnlyAfterTheDeadline {
  dispatch_queue_t queue = dispatch_queue_create("test.deadline", DISPATCH_QUEUE_SERIAL);
  XCTestExpectation *fired = [self expectationWithDescription:@"expire"];
  CFAbsoluteTime start = CFAbsoluteTimeGetCurrent();
  __block CFAbsoluteTime elapsed = 0;
  BGSRNArmFilterDeadline(150, queue, ^{
    elapsed = CFAbsoluteTimeGetCurrent() - start;
    [fired fulfill];
  });
  [self waitForExpectations:@[ fired ] timeout:5];
  XCTAssertGreaterThanOrEqual(elapsed, 0.14);
}

- (void)testACancelledDeadlineNeverRuns {
  dispatch_queue_t queue = dispatch_queue_create("test.deadline", DISPATCH_QUEUE_SERIAL);
  __block BOOL ran = NO;
  dispatch_block_t token = BGSRNArmFilterDeadline(50, queue, ^{
    ran = YES;
  });
  XCTAssertNotNil(token);
  BGSRNCancelFilterDeadline(token);
  XCTestExpectation *later = [self expectationWithDescription:@"later"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), queue, ^{
    [later fulfill];
  });
  [self waitForExpectations:@[ later ] timeout:5];
  XCTAssertFalse(ran);
}

- (void)testArmingWithoutAQueueOrABlockIsANoOp {
  XCTAssertNil(BGSRNArmFilterDeadline(1, nil, ^{
  }));
  XCTAssertNil(BGSRNArmFilterDeadline(1, dispatch_get_main_queue(), nil));
  BGSRNCancelFilterDeadline(nil);
}

/// The reply and the deadline race for the same item. Exactly one takes it.
- (void)testOnlyTheFirstTakeGetsThePendingItem {
  self.table[@"7"] = @"item";
  self.table[@"8"] = @"other";

  XCTAssertEqualObjects(BGSRNTakePendingFilter(self.table, self.lock, @"7"), @"item");
  XCTAssertNil(BGSRNTakePendingFilter(self.table, self.lock, @"7"));
  XCTAssertNil(self.table[@"7"]);
  XCTAssertEqualObjects(self.table[@"8"], @"other");
}

- (void)testTakingAnUnknownOrNilRequestReturnsNilAndKeepsTheTable {
  self.table[@"1"] = @"item";

  XCTAssertNil(BGSRNTakePendingFilter(self.table, self.lock, @"2"));
  XCTAssertNil(BGSRNTakePendingFilter(self.table, self.lock, nil));
  XCTAssertEqual(self.table.count, 1u);
}

/// A reply takes the item through the same call, so it stops the timer too.
- (void)testTakingAnItemCancelsItsDeadline {
  BGSRNFakePendingFilter *item = [self addPending:@"1"];
  __block BOOL ran = NO;
  dispatch_queue_t queue = dispatch_queue_create("test.deadline", DISPATCH_QUEUE_SERIAL);
  item.deadline = BGSRNArmFilterDeadline(50, queue, ^{
    ran = YES;
  });

  XCTAssertEqual(BGSRNTakePendingFilter(self.table, self.lock, @"1"), item);

  XCTestExpectation *later = [self expectationWithDescription:@"later"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), queue, ^{
    [later fulfill];
  });
  [self waitForExpectations:@[ later ] timeout:5];
  XCTAssertFalse(ran);
}

/// What the deadline does to a request: answer the SDK's decision with nil,
/// never with the item, and only once.
- (void)testDroppingAnswersTheDecisionWithNilExactlyOnce {
  [self addPending:@"1"];
  [self addPending:@"2"];

  XCTAssertTrue(BGSRNDropPendingFilter(self.table, self.lock, @"1"));
  XCTAssertFalse(BGSRNDropPendingFilter(self.table, self.lock, @"1"));

  XCTAssertEqual(self.answers.count, 1u);
  XCTAssertEqualObjects(self.answers[0], [NSNull null]);
  XCTAssertNil(self.table[@"1"]);
  XCTAssertNotNil(self.table[@"2"]);
}

- (void)testDroppingAnUnknownRequestAnswersNothing {
  XCTAssertFalse(BGSRNDropPendingFilter(self.table, self.lock, @"9"));
  XCTAssertEqual(self.answers.count, 0u);
}

- (void)testDroppingAnItemWithoutADecisionStillRemovesIt {
  self.table[@"1"] = [BGSRNFakePendingFilter new];

  XCTAssertTrue(BGSRNDropPendingFilter(self.table, self.lock, @"1"));
  XCTAssertNil(self.table[@"1"]);
}

/// The module's path end to end: armed on the request, the deadline passes,
/// the decision gets nil, and a reply afterwards finds nothing.
- (void)testAnArmedRequestIsDroppedAtTheDeadlineAndALateReplyFindsNothing {
  BGSRNFakePendingFilter *item = [self addPending:@"1"];
  dispatch_queue_t queue = dispatch_queue_create("test.deadline", DISPATCH_QUEUE_SERIAL);

  BGSRNArmPendingFilterDeadlineAfter(50, queue, self.table, self.lock, @"1");
  XCTAssertNotNil(item.deadline);
  XCTAssertEqual(self.answers.count, 0u);

  XCTestExpectation *later = [self expectationWithDescription:@"later"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), queue, ^{
    [later fulfill];
  });
  [self waitForExpectations:@[ later ] timeout:5];

  XCTAssertEqual(self.answers.count, 1u);
  XCTAssertEqualObjects(self.answers[0], [NSNull null]);
  XCTAssertNil(BGSRNTakePendingFilter(self.table, self.lock, @"1"));
}

/// The reply wins: its take cancels the timer, so the decision is not
/// answered a second time with nil.
- (void)testAReplyBeforeTheDeadlineLeavesTheDeadlineNothing {
  [self addPending:@"1"];
  dispatch_queue_t queue = dispatch_queue_create("test.deadline", DISPATCH_QUEUE_SERIAL);
  BGSRNArmPendingFilterDeadlineAfter(100, queue, self.table, self.lock, @"1");

  BGSRNFakePendingFilter *item = BGSRNTakePendingFilter(self.table, self.lock, @"1");
  item.decision(@"kept");

  XCTestExpectation *later = [self expectationWithDescription:@"later"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), queue, ^{
    [later fulfill];
  });
  [self waitForExpectations:@[ later ] timeout:5];

  XCTAssertEqual(self.answers.count, 1u);
  XCTAssertEqualObjects(self.answers[0], @"kept");
}

/// The deadline's queue is starved, so its block has not run, but the
/// deadline has passed. A reply that takes the item first is refused: the
/// decision is answered nil and nothing is returned to apply.
- (void)testAReplyPastTheDeadlineIsRefusedEvenIfTheTimerBlockHasNotRun {
  BGSRNFakePendingFilter *item = [self addPending:@"1"];
  dispatch_queue_t queue = dispatch_queue_create("test.starved", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t release = dispatch_semaphore_create(0);
  dispatch_async(queue, ^{
    dispatch_semaphore_wait(release, DISPATCH_TIME_FOREVER);
  });

  BGSRNArmPendingFilterDeadlineAfter(30, queue, self.table, self.lock, @"1");
  XCTAssertNotNil(item.expiresAt);
  [NSThread sleepForTimeInterval:0.15];

  XCTAssertNil(BGSRNTakePendingFilter(self.table, self.lock, @"1"));
  XCTAssertEqual(self.answers.count, 1u);
  XCTAssertEqualObjects(self.answers[0], [NSNull null]);
  XCTAssertNil(self.table[@"1"]);

  // The starved timer finally runs and finds nothing.
  dispatch_semaphore_signal(release);
  XCTestExpectation *drained = [self expectationWithDescription:@"drained"];
  dispatch_async(queue, ^{
    [drained fulfill];
  });
  [self waitForExpectations:@[ drained ] timeout:5];
  XCTAssertEqual(self.answers.count, 1u);
}

/// Inside the deadline a reply is still taken normally.
- (void)testAReplyInsideTheDeadlineIsStillTaken {
  BGSRNFakePendingFilter *item = [self addPending:@"1"];
  dispatch_queue_t queue = dispatch_queue_create("test.deadline", DISPATCH_QUEUE_SERIAL);
  BGSRNArmPendingFilterDeadlineAfter(5000, queue, self.table, self.lock, @"1");

  XCTAssertEqual(BGSRNTakePendingFilter(self.table, self.lock, @"1"), item);
  XCTAssertEqual(self.answers.count, 0u);
}

@end
