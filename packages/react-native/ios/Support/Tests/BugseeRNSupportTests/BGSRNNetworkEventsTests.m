@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

@interface BGSRNFakeManualNetworkEvent : NSObject
@property (nonatomic, copy, nullable) NSString *url;
@property (nonatomic, copy, nullable) NSString *body;
@property (nonatomic, copy, nullable) NSDictionary *headers;
@property (nonatomic, assign) NSInteger responseCode;
@property (nonatomic, copy, nullable) NSString *statusText;
@property (nonatomic, copy, nullable) NSString *errorDescription;
@property (nonatomic, copy, nullable) NSString *errorShortMessage;
@property (nonatomic, copy, nullable) NSString *redirectedFromURL;
@property (nonatomic, copy, nullable) NSDictionary *error;
@end

@implementation BGSRNFakeManualNetworkEvent
@end

@interface BGSRNNetworkEventsTests : XCTestCase
@end

@implementation BGSRNNetworkEventsTests

- (void)testCompletedRequiresFilteringAndStampsTheClock {
  __block NSTimeInterval seenTime = -1;
  __block BGSNetworkEventStage seenStage = BGSNetworkEventStageRequestStarted;
  __block NSString *seenMechanism = nil;
  __block NSString *seenMethod = nil;
  __block NSString *seenId = @"unset";
  BGSRNFakeManualNetworkEvent *made = [BGSRNFakeManualNetworkEvent new];
  __block id submitted = nil;
  __block BOOL filtering = NO;
  __block NSInteger submits = 0;

  BGSRNNetworkEventOutcome outcome = BGSRNRecordNetworkEvent(
      @{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"completed"},
      ^id(NSTimeInterval timestamp, BGSNetworkEventStage stage, NSString *eventId, NSString *mechanism,
          NSString *method) {
        seenTime = timestamp;
        seenStage = stage;
        seenId = eventId;
        seenMechanism = mechanism;
        seenMethod = method;
        return made;
      },
      ^(id event, BOOL requiresFiltering) {
        submits += 1;
        submitted = event;
        filtering = requiresFiltering;
      },
      1700000000000.0);

  XCTAssertEqual(outcome, BGSRNNetworkEventOutcomeAdded);
  XCTAssertEqual(seenTime, 1700000000000.0);
  XCTAssertEqual(seenStage, BGSNetworkEventStageRequestCompleted);
  XCTAssertEqualObjects(seenMechanism, @"react-native");
  XCTAssertEqualObjects(seenMethod, @"GET");
  XCTAssertNil(seenId);
  XCTAssertEqual(submits, 1);
  XCTAssertTrue(filtering);
  XCTAssertEqualObjects(made.url, @"https://e2e.example/keep");
  XCTAssertEqual(submitted, made);
}

- (void)testANilCreateDropsWithoutSubmitting {
  __block NSInteger submits = 0;
  BGSRNNetworkEventOutcome missing = BGSRNRecordNetworkEvent(
      @{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"completed"}, nil,
      ^(id event, BOOL requiresFiltering) {
        submits += 1;
      },
      0);
  XCTAssertEqual(missing, BGSRNNetworkEventOutcomeNoEvent);
  BGSRNNetworkEventOutcome empty = BGSRNRecordNetworkEvent(
      @{@"url" : @"https://e2e.example/keep", @"method" : @"GET", @"stage" : @"complete"},
      ^id(NSTimeInterval timestamp, BGSNetworkEventStage stage, NSString *eventId, NSString *mechanism,
          NSString *method) {
        return nil;
      },
      ^(id event, BOOL requiresFiltering) {
        submits += 1;
      },
      0);
  XCTAssertEqual(empty, BGSRNNetworkEventOutcomeNoEvent);
  XCTAssertEqual(submits, 0);
}

- (void)testWritableFilterFieldsAreSet {
  BGSRNFakeManualNetworkEvent *made = [BGSRNFakeManualNetworkEvent new];
  __block BGSNetworkEventStage seenStage = BGSNetworkEventStageRequestStarted;
  BGSRNNetworkEventOutcome outcome = BGSRNRecordNetworkEvent(
      @{
        @"url" : @"https://e2e.example/keep",
        @"method" : @"POST",
        @"stage" : @"error",
        @"id" : @"evt-1",
        @"body" : @"secret",
        @"headers" : @{@"Authorization" : @"Bearer x"},
        @"responseCode" : @201,
        @"statusText" : @"Created",
        @"errorDescription" : @"none",
        @"errorShortMessage" : @"ok",
        @"redirectedFromURL" : @"https://e2e.example/from",
        @"error" : @{@"domain" : @"test"},
      },
      ^id(NSTimeInterval timestamp, BGSNetworkEventStage stage, NSString *eventId, NSString *mechanism,
          NSString *method) {
        seenStage = stage;
        XCTAssertEqualObjects(eventId, @"evt-1");
        return made;
      },
      ^(id event, BOOL requiresFiltering) {
        XCTAssertTrue(requiresFiltering);
      },
      5);
  XCTAssertEqual(outcome, BGSRNNetworkEventOutcomeAdded);
  XCTAssertEqual(seenStage, BGSNetworkEventStageRequestErrored);
  XCTAssertEqualObjects(made.body, @"secret");
  XCTAssertEqualObjects(made.headers[@"Authorization"], @"Bearer x");
  XCTAssertEqual(made.responseCode, 201);
  XCTAssertEqualObjects(made.statusText, @"Created");
  XCTAssertEqualObjects(made.errorDescription, @"none");
  XCTAssertEqualObjects(made.errorShortMessage, @"ok");
  XCTAssertEqualObjects(made.redirectedFromURL, @"https://e2e.example/from");
  XCTAssertEqualObjects(made.error[@"domain"], @"test");
}

@end
