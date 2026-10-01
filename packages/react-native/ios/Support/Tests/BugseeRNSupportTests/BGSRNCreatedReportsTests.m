@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

#include <stdatomic.h>

/// Mirrors Android's `CreatedReportsTest` by name, with a `test` prefix.
/// Each case builds its own registry: handles are `cr-1`, `cr-2`, … per
/// registry, so a shared process counter would make `cr-1` depend on order.
@interface BGSRNCreatedReportsTests : XCTestCase
@end

@implementation BGSRNCreatedReportsTests

- (BugseeExtendedReport *)newReport {
  return [BugseeExtendedReport new];
}

- (void)testOneOutstandingAtATime {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  XCTAssertTrue([registry reserve]);
  XCTAssertFalse([registry reserve]);

  NSString *handle = [registry fulfil:[self newReport]];
  XCTAssertNotNil(handle);
  XCTAssertFalse([registry reserve], @"a fulfilled report still holds the slot");
}

- (void)testANullReportFreesTheSlot {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  XCTAssertTrue([registry reserve]);
  XCTAssertNil([registry fulfil:nil]);
  XCTAssertTrue([registry reserve], @"a nil report is the SDK making none, and the slot must open");
}

- (void)testTakeFreesTheSlot {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  XCTAssertTrue([registry reserve]);
  BugseeExtendedReport *report = [self newReport];
  NSString *handle = [registry fulfil:report];
  XCTAssertEqual([registry take:handle], report);
  XCTAssertTrue([registry reserve]);
}

- (void)testHandlesAreFreshAndPrefixed {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  XCTAssertTrue([registry reserve]);
  NSString *first = [registry fulfil:[self newReport]];
  XCTAssertEqualObjects(first, @"cr-1");

  XCTAssertNotNil([registry take:first]);
  XCTAssertTrue([registry reserve]);
  NSString *second = [registry fulfil:[self newReport]];
  XCTAssertEqualObjects(second, @"cr-2");
  XCTAssertNotEqualObjects(first, second, @"a taken handle is never reused");
}

- (void)testATakenHandleIsGone {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  XCTAssertTrue([registry reserve]);
  BugseeExtendedReport *report = [self newReport];
  NSString *handle = [registry fulfil:report];
  XCTAssertEqual([registry reportFor:handle], report);
  XCTAssertEqual([registry take:handle], report);
  XCTAssertNil([registry reportFor:handle]);
  XCTAssertNil([registry take:handle]);
}

- (void)testClearFreesEverything {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  XCTAssertTrue([registry reserve]);
  NSString *handle = [registry fulfil:[self newReport]];
  [registry clear];
  XCTAssertNil([registry reportFor:handle]);
  XCTAssertNil([registry take:handle]);
  XCTAssertTrue([registry reserve]);

  // A reservation the SDK has not answered yet is still a held slot.
  [registry clear];
  XCTAssertTrue([registry reserve]);
}

/// Eight threads pass one start barrier and call `reserve`. The lock admits
/// one. A plain check-then-set lets more than one through.
- (void)testConcurrentReservationsAdmitOne {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const int threads = 8;
  __block atomic_int wins = 0;
  dispatch_group_t start = dispatch_group_create();
  dispatch_group_t done = dispatch_group_create();
  dispatch_group_enter(start);

  for (int i = 0; i < threads; i++) {
    dispatch_group_enter(done);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      dispatch_group_wait(start, DISPATCH_TIME_FOREVER);
      if ([registry reserve]) {
        atomic_fetch_add_explicit(&wins, 1, memory_order_relaxed);
      }
      dispatch_group_leave(done);
    });
  }

  dispatch_group_leave(start);
  dispatch_group_wait(done, DISPATCH_TIME_FOREVER);
  XCTAssertEqual(atomic_load_explicit(&wins, memory_order_relaxed), 1);
}

@end
