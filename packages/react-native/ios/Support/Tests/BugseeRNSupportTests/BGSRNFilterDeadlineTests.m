@import XCTest;
@import BugseeRNSupport;

/// The wrapper's own deadline for a filter JS never answers. The SDK has none
/// on iOS, so without it a hung callback keeps its request, and the event the
/// request retains, until the process dies.
@interface BGSRNFilterDeadlineTests : XCTestCase
@end

@implementation BGSRNFilterDeadlineTests

/// Same number as Android's log and network bridges.
- (void)testTheDeadlineIsNineSeconds {
  XCTAssertEqual(BGSRNFilterDeadlineMs, 9000);
}

- (void)testExpireRunsAfterTheDeadlineAndNotBefore {
  XCTestExpectation *fired = [self expectationWithDescription:@"expire"];
  __block BOOL early = YES;
  __block BOOL ranEarly = NO;
  CFAbsoluteTime start = CFAbsoluteTimeGetCurrent();
  BGSRNArmFilterDeadline(100, dispatch_get_main_queue(), ^{
    ranEarly = early;
    XCTAssertGreaterThanOrEqual(CFAbsoluteTimeGetCurrent() - start, 0.09);
    [fired fulfill];
  });
  early = NO;
  XCTAssertFalse(ranEarly);
  [self waitForExpectations:@[ fired ] timeout:5];
  XCTAssertFalse(ranEarly);
}

- (void)testArmingWithoutAQueueOrABlockIsANoOp {
  BGSRNArmFilterDeadline(1, nil, ^{
    XCTFail(@"no queue");
  });
  BGSRNArmFilterDeadline(1, dispatch_get_main_queue(), nil);
}

/// The reply and the deadline race for the same item. Exactly one takes it.
- (void)testOnlyTheFirstTakeGetsThePendingItem {
  NSMutableDictionary<NSString *, id> *table = [NSMutableDictionary dictionary];
  id lock = [NSObject new];
  table[@"7"] = @"item";
  table[@"8"] = @"other";

  XCTAssertEqualObjects(BGSRNTakePendingFilter(table, lock, @"7"), @"item");
  XCTAssertNil(BGSRNTakePendingFilter(table, lock, @"7"));
  XCTAssertNil(table[@"7"]);
  // Another request is untouched.
  XCTAssertEqualObjects(table[@"8"], @"other");
}

- (void)testTakingAnUnknownOrNilRequestReturnsNilAndKeepsTheTable {
  NSMutableDictionary<NSString *, id> *table = [NSMutableDictionary dictionaryWithObject:@"item" forKey:@"1"];
  id lock = [NSObject new];

  XCTAssertNil(BGSRNTakePendingFilter(table, lock, @"2"));
  XCTAssertNil(BGSRNTakePendingFilter(table, lock, nil));
  XCTAssertEqual(table.count, 1u);
}

/// The way the module uses it: the deadline takes the item and drops it, and
/// a reply after that finds nothing.
- (void)testADeadlineThatTakesTheItemLeavesALateReplyNothing {
  NSMutableDictionary<NSString *, id> *table = [NSMutableDictionary dictionary];
  id lock = [NSObject new];
  table[@"1"] = @"item";
  XCTestExpectation *expired = [self expectationWithDescription:@"expired"];
  __block id dropped = nil;
  BGSRNArmFilterDeadline(10, dispatch_get_main_queue(), ^{
    dropped = BGSRNTakePendingFilter(table, lock, @"1");
    [expired fulfill];
  });
  [self waitForExpectations:@[ expired ] timeout:5];

  XCTAssertEqualObjects(dropped, @"item");
  XCTAssertNil(BGSRNTakePendingFilter(table, lock, @"1"));
}

/// The reply wins: the deadline then finds nothing and must not drop.
- (void)testAReplyBeforeTheDeadlineLeavesTheDeadlineNothing {
  NSMutableDictionary<NSString *, id> *table = [NSMutableDictionary dictionary];
  id lock = [NSObject new];
  table[@"1"] = @"item";
  XCTestExpectation *expired = [self expectationWithDescription:@"expired"];
  __block id fromDeadline = @"unset";
  BGSRNArmFilterDeadline(50, dispatch_get_main_queue(), ^{
    fromDeadline = BGSRNTakePendingFilter(table, lock, @"1");
    [expired fulfill];
  });
  XCTAssertEqualObjects(BGSRNTakePendingFilter(table, lock, @"1"), @"item");
  [self waitForExpectations:@[ expired ] timeout:5];

  XCTAssertNil(fromDeadline);
}

@end
