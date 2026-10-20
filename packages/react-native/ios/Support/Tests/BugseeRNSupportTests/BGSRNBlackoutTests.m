@import XCTest;
@import BugseeRNSupport;

/// Pins `BGSRNEndBlackoutForStop`: `stop()` ends a blackout on iOS as it does
/// on Android (#143), and does not fabricate an end when none is in force.
@interface BGSRNBlackoutTests : XCTestCase
@end

@implementation BGSRNBlackoutTests

- (void)testEndsABlackoutInForce {
  __block NSInteger ended = 0;
  BOOL result = BGSRNEndBlackoutForStop(^BOOL {
    return YES;
  }, ^{
    ended += 1;
  });
  XCTAssertTrue(result);
  XCTAssertEqual(ended, 1);
}

- (void)testDoesNothingWhenNoBlackout {
  __block NSInteger ended = 0;
  BOOL result = BGSRNEndBlackoutForStop(^BOOL {
    return NO;
  }, ^{
    ended += 1;
  });
  XCTAssertFalse(result);
  XCTAssertEqual(ended, 0);
}

@end
