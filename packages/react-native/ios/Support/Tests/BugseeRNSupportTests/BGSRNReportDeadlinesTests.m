@import XCTest;
@import BugseeRNSupport;

/// The deadline JS gets for a handle must land inside the SDK's cap for the
/// path it is on. Overshooting is not a softer failure: the SDK proceeds
/// without us, and whatever JS writes after that goes to a report that has
/// already moved on.
@interface BGSRNReportDeadlinesTests : XCTestCase
@end

@implementation BGSRNReportDeadlinesTests

/// Live reports are dispatched on main with a 30 s per-handler cap; recovered
/// ones off main with a 3 s cap. Each deadline stops short of its cap.
- (void)testMainThreadIsLiveAndOffMainIsRecovery {
  XCTAssertEqual(BGSRNLiveDeadlineMs, 25000);
  XCTAssertEqual(BGSRNRecoveryDeadlineMs, 2500);
  XCTAssertEqual(BGSRNDeadlineMs(YES), 25000);
  XCTAssertEqual(BGSRNDeadlineMs(NO), 2500);
}

@end
