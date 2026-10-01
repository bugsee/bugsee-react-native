@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// Upload severity is the requested value when it is 1..5, otherwise the
/// launch option, otherwise High (3). A nil string array stays nil.
@interface BGSRNReportArgsTests : XCTestCase
@end

@implementation BGSRNReportArgsTests

- (void)testARequestedSeverityWins {
  NSDictionary *options = @{BugseeOptionReportingDefaultBugPriority : @(BugseeSeverityLow)};
  XCTAssertEqual(BGSRNUploadSeverity(BugseeSeverityCritical, options), BugseeSeverityCritical);
  XCTAssertEqual(BGSRNUploadSeverity(BugseeSeverityLow, nil), BugseeSeverityLow);
  XCTAssertEqual(BGSRNDefaultBugPriorityFallback, 3);
}

- (void)testZeroTakesTheLaunchOption {
  NSDictionary *options =
      @{BugseeOptionReportingDefaultBugPriority : @(BugseeSeverityCritical)};
  XCTAssertEqual(BGSRNUploadSeverity(0, options), BugseeSeverityCritical);
}

- (void)testZeroWithoutTheOptionIsHigh {
  XCTAssertEqual(BGSRNUploadSeverity(0, @{}), BugseeSeverityHigh);
  XCTAssertEqual(BGSRNUploadSeverity(0, nil), BugseeSeverityHigh);
}

- (void)testAnOutOfRangeOptionIsHigh {
  XCTAssertEqual(BGSRNUploadSeverity(0, @{BugseeOptionReportingDefaultBugPriority : @(6)}),
                 BugseeSeverityHigh);
  XCTAssertEqual(BGSRNUploadSeverity(0, @{BugseeOptionReportingDefaultBugPriority : @(0)}),
                 BugseeSeverityHigh);
  XCTAssertEqual(BGSRNUploadSeverity(0, @{BugseeOptionReportingDefaultBugPriority : @(2.5)}),
                 BugseeSeverityHigh);
  XCTAssertEqual(BGSRNUploadSeverity(0, @{BugseeOptionReportingDefaultBugPriority : @"4"}),
                 BugseeSeverityHigh);
}

- (void)testStringArrayKeepsStrings {
  NSArray *mixed = @[ @"a", @1, @"b" ];
  XCTAssertEqualObjects(BGSRNStringArray(mixed), (@[ @"a", @"b" ]));
  XCTAssertEqualObjects(BGSRNStringArray(@[ @"only" ]), (@[ @"only" ]));
}

- (void)testStringArrayOfNilIsNil {
  XCTAssertNil(BGSRNStringArray(nil));
}

@end
