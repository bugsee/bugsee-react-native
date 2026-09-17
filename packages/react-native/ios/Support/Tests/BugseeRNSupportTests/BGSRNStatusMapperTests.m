@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// The JS side has its own Status constants; these pin the mapping between
/// them and the SDK's enum. Getting it wrong is silent — a caller polling for
/// "launched" simply never sees it.
@interface BGSRNStatusMapperTests : XCTestCase
@end

@implementation BGSRNStatusMapperTests

- (void)testMapsEveryStatusToItsWireNumber {
  XCTAssertEqual(0, BGSRNStatusToWire(BugseeStatusStopped));
  XCTAssertEqual(1, BGSRNStatusToWire(BugseeStatusLaunching));
  XCTAssertEqual(2, BGSRNStatusToWire(BugseeStatusLaunched));
  XCTAssertEqual(3, BGSRNStatusToWire(BugseeStatusStopping));
}

/// An unrecognised status means "we could not tell", which is far closer to
/// stopped than launched: a caller waiting to start should keep waiting.
- (void)testMapsAnUnknownStatusToStopped {
  XCTAssertEqual(0, BGSRNStatusToWire((BugseeStatus)99));
}

/// Distinct states must stay distinguishable — collapsing two onto one wire
/// number leaves a caller unable to tell launching from launched.
- (void)testGivesEveryStatusADistinctWireNumber {
  NSMutableSet *seen = [NSMutableSet set];
  BugseeStatus all[] = {BugseeStatusStopped, BugseeStatusLaunching,
                        BugseeStatusLaunched, BugseeStatusStopping};
  for (NSUInteger i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
    NSNumber *wire = @(BGSRNStatusToWire(all[i]));
    XCTAssertFalse([seen containsObject:wire], @"duplicate wire number %@", wire);
    [seen addObject:wire];
  }
}

/// The wire numbers are shared with the Android bridge, which pins the same
/// four in BugseeStatusMapper. They are API, not an implementation detail.
- (void)testWireNumbersMatchTheSharedContract {
  XCTAssertEqual(0, BGSRNStatusWireStopped);
  XCTAssertEqual(1, BGSRNStatusWireLaunching);
  XCTAssertEqual(2, BGSRNStatusWireLaunched);
  XCTAssertEqual(3, BGSRNStatusWireStopping);
}

@end

@interface BGSRNTokensTests : XCTestCase
@end

@implementation BGSRNTokensTests

- (void)testRejectsBlankTokens {
  XCTAssertFalse(BGSRNTokenIsUsable(nil));
  XCTAssertFalse(BGSRNTokenIsUsable(@""));
  XCTAssertFalse(BGSRNTokenIsUsable(@"   "));
  XCTAssertFalse(BGSRNTokenIsUsable(@"\t\n"));
}

- (void)testAcceptsARealToken {
  XCTAssertTrue(BGSRNTokenIsUsable(@"00000000-0000-4000-8000-000000000000"));
}

/// Surrounding whitespace is a copy-paste artefact, not a different token.
- (void)testAcceptsATokenPaddedWithWhitespace {
  XCTAssertTrue(BGSRNTokenIsUsable(@"  tok  "));
}

/// JavaScript is not typed, and a TurboModule declaring `string` can still be
/// handed a number. Objective-C will not stop it: the pointer arrives typed as
/// NSString* and only blows up when a string selector is sent to it. Reject it
/// here instead of crashing inside the SDK.
- (void)testRejectsAValueThatIsNotAString {
  XCTAssertFalse(BGSRNTokenIsUsable((NSString *)(id)@42));
  XCTAssertFalse(BGSRNTokenIsUsable((NSString *)(id)@[ @"tok" ]));
  XCTAssertFalse(BGSRNTokenIsUsable((NSString *)(id)[NSNull null]));
}

@end
