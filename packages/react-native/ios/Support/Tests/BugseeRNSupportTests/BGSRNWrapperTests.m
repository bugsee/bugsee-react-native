@import XCTest;
@import BugseeRNSupport;

@interface BGSRNWrapperTests : XCTestCase
@end

@implementation BGSRNWrapperTests

- (void)testReportsWhatItWasGiven {
  BGSRNWrapper *wrapper = [BGSRNWrapper wrapperWithIdentity:@{
    @"type" : @"react_native",
    @"version" : @"1.2.3",
    @"build" : @"42",
    @"context" : @{@"react-native" : @"0.87.1"},
  }];

  XCTAssertEqualObjects(wrapper.wrapperType, @"react_native");
  XCTAssertEqualObjects(wrapper.wrapperVersion, @"1.2.3");
  XCTAssertEqualObjects(wrapper.wrapperBuild, @"42");
  XCTAssertEqualObjects(wrapper.context[@"react-native"], @"0.87.1");
}

/// The SDK declares these non-null. Reporting "unknown" is honest; an empty
/// string reads in a report as "this wrapper has no version".
- (void)testFallsBackToUnknownRatherThanEmpty {
  BGSRNWrapper *wrapper = [BGSRNWrapper wrapperWithIdentity:@{@"version" : @""}];
  XCTAssertEqualObjects(wrapper.wrapperType, @"unknown");
  XCTAssertEqualObjects(wrapper.wrapperVersion, @"unknown");
}

- (void)testSurvivesAnIdentityThatIsNotADictionary {
  BGSRNWrapper *wrapper = [BGSRNWrapper wrapperWithIdentity:(id) @"nonsense"];
  XCTAssertEqualObjects(wrapper.wrapperType, @"unknown");
  XCTAssertNil(wrapper.wrapperBuild);
}

- (void)testAllowsNoBuild {
  XCTAssertNil([BGSRNWrapper wrapperWithIdentity:@{@"type" : @"react_native"}].wrapperBuild);
}

/// A number rendered as "1" cannot be told apart from a version the wrapper
/// actually reported, so a non-string value is dropped instead.
- (void)testDropsNonStringContextValues {
  BGSRNWrapper *wrapper = [BGSRNWrapper wrapperWithIdentity:@{
    @"context" : @{@"good" : @"yes", @"bad" : @1, @"worse" : [NSNull null]},
  }];
  XCTAssertEqualObjects(wrapper.context[@"good"], @"yes");
  XCTAssertNil(wrapper.context[@"bad"]);
  XCTAssertEqual(wrapper.context.count, (NSUInteger)1);
}

- (void)testHasNoContextWhenNoneWasSupplied {
  XCTAssertNil([BGSRNWrapper wrapperWithIdentity:@{@"type" : @"x"}].context);
}

@end
