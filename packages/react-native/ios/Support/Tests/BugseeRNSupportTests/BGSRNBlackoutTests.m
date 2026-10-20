@import XCTest;
@import BugseeRNSupport;
@import Bugsee;

/// Pins `BGSRNEndBlackoutForStop` against the real SDK: `stop()` ends a
/// blackout on iOS as it does on Android (#143), and a pre-launch
/// `startBlackout()` on a never-launched SDK is left alone.
@interface BGSRNBlackoutTests : XCTestCase
@end

@implementation BGSRNBlackoutTests

- (void)tearDown {
  [Bugsee endBlackout];
  [super tearDown];
}

- (void)testEndsABlackoutWhenTheSdkIsNotStopped {
  [Bugsee startBlackout];
  XCTAssertTrue([Bugsee isBlackout]);
  XCTAssertTrue(BGSRNEndBlackoutForStopWithStatus(BugseeStatusLaunched));
  XCTAssertFalse([Bugsee isBlackout]);
}

- (void)testLeavesAPreLaunchBlackoutWhenStopped {
  [Bugsee startBlackout];
  XCTAssertFalse(BGSRNEndBlackoutForStopWithStatus(BugseeStatusStopped));
  XCTAssertTrue([Bugsee isBlackout]);
  XCTAssertFalse(BGSRNEndBlackoutForStop());  // never launched here: Stopped
  XCTAssertTrue([Bugsee isBlackout]);
}

- (void)testDoesNothingWhenNoBlackout {
  XCTAssertFalse([Bugsee isBlackout]);
  XCTAssertFalse(BGSRNEndBlackoutForStopWithStatus(BugseeStatusLaunched));
}

@end
