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
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  XCTAssertFalse([registry reserve]);

  NSString *handle = [registry fulfil:[self newReport] reservation:reservation];
  XCTAssertNotNil(handle);
  XCTAssertFalse([registry reserve], @"a fulfilled report still holds the slot");
}

- (void)testANullReportFreesTheSlot {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  XCTAssertNil([registry fulfil:nil reservation:reservation]);
  XCTAssertTrue([registry reserve], @"a nil report is the SDK making none, and the slot must open");
}

- (void)testTakeFreesTheSlot {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  BugseeExtendedReport *report = [self newReport];
  NSString *handle = [registry fulfil:report reservation:reservation];
  XCTAssertEqual([registry take:handle], report);
  XCTAssertTrue([registry reserve]);
}

- (void)testHandlesAreFreshAndPrefixed {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger firstReservation = [registry reserve];
  XCTAssertTrue(firstReservation);
  NSString *first = [registry fulfil:[self newReport] reservation:firstReservation];
  XCTAssertEqualObjects(first, @"cr-1");

  XCTAssertNotNil([registry take:first]);
  const NSUInteger secondReservation = [registry reserve];
  XCTAssertTrue(secondReservation);
  NSString *second = [registry fulfil:[self newReport] reservation:secondReservation];
  XCTAssertEqualObjects(second, @"cr-2");
  XCTAssertNotEqualObjects(first, second, @"a taken handle is never reused");
}

- (void)testATakenHandleIsGone {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  BugseeExtendedReport *report = [self newReport];
  NSString *handle = [registry fulfil:report reservation:reservation];
  XCTAssertEqual([registry reportFor:handle], report);
  XCTAssertEqual([registry take:handle], report);
  XCTAssertNil([registry reportFor:handle]);
  XCTAssertNil([registry take:handle]);
}

- (void)testClearFreesEverything {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  NSString *handle = [registry fulfil:[self newReport] reservation:reservation];
  [registry clear];
  XCTAssertNil([registry reportFor:handle]);
  XCTAssertNil([registry take:handle]);
  XCTAssertTrue([registry reserve]);

  // A reservation the SDK has not answered yet is still a held slot.
  [registry clear];
  XCTAssertTrue([registry reserve]);
}

/// `clear` does not cancel the SDK completion. That completion's token must
/// not store its report into the reservation a later runtime already opened.
- (void)testAStaleReportLeavesTheNextReservationEmpty {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger stale = [registry reserve];
  XCTAssertTrue(stale);
  [registry clear];

  const NSUInteger live = [registry reserve];
  XCTAssertTrue(live);
  XCTAssertNotEqual(live, stale);

  BugseeExtendedReport *abandoned = [self newReport];
  XCTAssertNil([registry fulfil:abandoned reservation:stale]);
  XCTAssertFalse([registry reserve], @"the new reservation is still open");
  XCTAssertNil([registry reportFor:@"cr-1"]);

  BugseeExtendedReport *created = [self newReport];
  XCTAssertEqualObjects([registry fulfil:created reservation:live], @"cr-1");
  XCTAssertEqual([registry reportFor:@"cr-1"], created);
}

/// The handle dies at detach. The slot stays taken until `endUpload:` so a
/// second `createReport` cannot run while `uploadReport:` is still copying.
- (void)testAnUploadInFlightKeepsTheSlot {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  BugseeExtendedReport *report = [self newReport];
  NSString *handle = [registry fulfil:report reservation:reservation];
  NSUInteger generation = 0;
  XCTAssertEqual([registry detachForUpload:handle generation:&generation], report);
  XCTAssertNotEqual(generation, 0u);
  XCTAssertNil([registry reportFor:handle]);
  XCTAssertFalse([registry reserve]);
  [registry endUpload:generation];
  XCTAssertTrue([registry reserve]);
}

/// `clear` drops the handle and still holds the slot while the upload copies.
/// `endUpload:` then opens it. A repeat of that generation does not drop the
/// report reserved afterwards.
- (void)testClearDuringUploadKeepsTheSlotUntilEnd {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  NSString *handle = [registry fulfil:[self newReport] reservation:reservation];
  NSUInteger generation = 0;
  XCTAssertNotNil([registry detachForUpload:handle generation:&generation]);
  [registry clear];
  XCTAssertFalse([registry reserve]);

  [registry endUpload:generation];
  const NSUInteger next = [registry reserve];
  XCTAssertTrue(next);
  BugseeExtendedReport *created = [self newReport];
  XCTAssertEqualObjects([registry fulfil:created reservation:next], @"cr-2");
  [registry endUpload:generation];
  XCTAssertEqual([registry reportFor:@"cr-2"], created);
  XCTAssertFalse([registry reserve]);
}

/// A nil completion for a reservation that already stored its report must not
/// drop that report. The token was consumed when the report was published.
- (void)testAStaleNilLeavesThePublishedHandle {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  BugseeExtendedReport *report = [self newReport];
  NSString *handle = [registry fulfil:report reservation:reservation];
  XCTAssertEqualObjects(handle, @"cr-1");

  XCTAssertNil([registry fulfil:nil reservation:reservation]);
  XCTAssertEqual([registry reportFor:handle], report);
  XCTAssertFalse([registry reserve]);
}

/// The module reserves before the main hop. `clear` on another queue ends
/// that token. The hop must see it closed, the stale report must not hold
/// the slot, and a later reserve must admit.
- (void)testClearBeforeTheHopClosesTheReservation {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  XCTAssertTrue([registry reservationIsOpen:reservation]);

  dispatch_group_t done = dispatch_group_create();
  dispatch_group_enter(done);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [registry clear];
    dispatch_group_leave(done);
  });
  dispatch_group_wait(done, DISPATCH_TIME_FOREVER);

  XCTAssertFalse([registry reservationIsOpen:reservation]);
  XCTAssertNil([registry fulfil:[self newReport] reservation:reservation]);
  const NSUInteger next = [registry reserve];
  XCTAssertTrue(next);
  XCTAssertNotEqual(next, reservation);
  XCTAssertTrue([registry reservationIsOpen:next]);
  XCTAssertFalse([registry reservationIsOpen:reservation]);
}

/// Once `createReportWithCompletion:` has been called, `clear` must not free
/// the slot. A second `-init` would wipe the file-scope attributes beta3
/// shares. The stale fulfil frees the slot and does not publish a handle.
- (void)testClearDuringCreateKeepsTheSlotUntilFulfil {
  BGSRNCreatedReports *registry = [BGSRNCreatedReports new];
  const NSUInteger reservation = [registry reserve];
  XCTAssertTrue(reservation);
  XCTAssertTrue([registry beginCreate:reservation]);
  XCTAssertFalse([registry beginCreate:reservation], @"the SDK call is started once");

  [registry clear];
  XCTAssertFalse([registry reservationIsOpen:reservation]);
  XCTAssertFalse([registry reserve], @"the in-flight create still holds the slot");
  XCTAssertNil([registry fulfil:[self newReport] reservation:reservation]);
  XCTAssertNil([registry reportFor:@"cr-1"]);

  const NSUInteger next = [registry reserve];
  XCTAssertTrue(next);
  XCTAssertNotEqual(next, reservation);
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
