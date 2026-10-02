@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

@interface BGSRNNetworkEventsTests : XCTestCase
@end

@implementation BGSRNNetworkEventsTests

- (void)testCompletedRequiresFilteringAndStampsTheClock {
  __block BugseeNetworkEvent *submitted = nil;
  __block BOOL filtering = NO;
  __block NSInteger submits = 0;

  BGSRNNetworkEventOutcome outcome = BGSRNRecordNetworkEvent(
      @{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"completed"},
      ^(BugseeNetworkEvent *event, BOOL requiresFiltering) {
        submits += 1;
        submitted = event;
        filtering = requiresFiltering;
      },
      1700000000000.0);

  XCTAssertEqual(outcome, BGSRNNetworkEventOutcomeAdded);
  XCTAssertEqual(submits, 1);
  XCTAssertTrue(filtering);
  XCTAssertEqual(submitted.type, BugseeNetwork);
  XCTAssertEqualObjects(submitted.bugseeNetworkEventType, BugseeNetworkEventComplete);
  XCTAssertEqualObjects(submitted.mechanism, @"react-native");
  XCTAssertEqualObjects(submitted.method, @"GET");
  XCTAssertEqualObjects(submitted.url, @"https://e2e.example/keep");
  XCTAssertEqual(submitted.timestamp, 1700000000000.0);
  XCTAssertGreaterThan(submitted.ID.length, 0u);
}

- (void)testAnUnknownStageIsNotSubmitted {
  __block NSInteger submits = 0;
  BGSRNNetworkEventOutcome outcome = BGSRNRecordNetworkEvent(
      @{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"done"},
      ^(BugseeNetworkEvent *event, BOOL requiresFiltering) {
        submits += 1;
      },
      0);
  XCTAssertEqual(outcome, BGSRNNetworkEventOutcomeRejected);
  XCTAssertEqual(submits, 0);
}

- (void)testWritableFilterFieldsAreSet {
  __block BugseeNetworkEvent *submitted = nil;
  BGSRNNetworkEventOutcome outcome = BGSRNRecordNetworkEvent(
      @{
        @"url" : @"https://e2e.example/keep",
        @"method" : @"POST",
        @"stage" : @"error",
        @"id" : @"evt-1",
        @"body" : @"secret",
        @"headers" : @{@"Authorization" : @"Bearer x"},
        @"responseCode" : @201,
        @"redirectedFromURL" : @"https://e2e.example/from",
        @"error" : @{@"domain" : @"test"},
      },
      ^(BugseeNetworkEvent *event, BOOL requiresFiltering) {
        XCTAssertTrue(requiresFiltering);
        submitted = event;
      },
      5);
  XCTAssertEqual(outcome, BGSRNNetworkEventOutcomeAdded);
  XCTAssertEqual(submitted.type, BugseeNetwork);
  XCTAssertEqualObjects(submitted.bugseeNetworkEventType, BugseeNetworkEventError);
  XCTAssertEqualObjects(submitted.ID, @"evt-1");
  XCTAssertEqualObjects(submitted.method, @"POST");
  NSString *body = [[NSString alloc] initWithData:submitted.body encoding:NSUTF8StringEncoding];
  XCTAssertEqualObjects(body, @"secret");
  XCTAssertEqualObjects(submitted.headers[@"Authorization"], @"Bearer x");
  XCTAssertEqual(submitted.responseCode, 201);
  XCTAssertEqualObjects(submitted.redirectedFromURL, @"https://e2e.example/from");
  XCTAssertEqualObjects(submitted.error[@"domain"], @"test");
  XCTAssertEqualObjects(submitted.mechanism, @"react-native");
  XCTAssertEqual(submitted.timestamp, 5);
}

- (void)testBeginAndCancelUseThoseConstants {
  __block NSString *begin = nil;
  __block NSString *cancel = nil;
  BGSRNRecordNetworkEvent(@{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"before"},
                          ^(BugseeNetworkEvent *event, BOOL requiresFiltering) {
                            begin = event.bugseeNetworkEventType;
                          },
                          1);
  BGSRNRecordNetworkEvent(@{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"abort"},
                          ^(BugseeNetworkEvent *event, BOOL requiresFiltering) {
                            cancel = event.bugseeNetworkEventType;
                          },
                          1);
  XCTAssertEqualObjects(begin, BugseeNetworkEventBegin);
  XCTAssertEqualObjects(cancel, BugseeNetworkEventCancel);
}

@end
