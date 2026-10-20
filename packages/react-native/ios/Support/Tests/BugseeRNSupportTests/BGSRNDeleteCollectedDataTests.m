@import XCTest;
@import BugseeRNSupport;

/// Pins `BGSRNDeleteCollectedData`: the promise carries the SDK's outcome however
/// long it takes, and only a long backstop, as a rejection, ends a wait that
/// never completes.
@interface BGSRNDeleteCollectedDataTests : XCTestCase
@end

@implementation BGSRNDeleteCollectedDataTests

- (dispatch_queue_t)queue {
  return dispatch_queue_create("com.bugsee.rn.delete.test", DISPATCH_QUEUE_SERIAL);
}

- (void)testResolvesWithTheSDKOutcome {
  for (NSNumber *outcome in @[ @YES, @NO ]) {
    XCTestExpectation *done = [self expectationWithDescription:@"resolved"];
    __block NSInteger settles = 0;
    __block BOOL value = !outcome.boolValue;
    BGSRNDeleteCollectedData(
        ^(void (^completion)(BOOL)) {
          completion(outcome.boolValue);
        },
        5000, [self queue],
        ^(BOOL success) {
          settles += 1;
          value = success;
          [done fulfill];
        },
        ^(NSString *code) {
          XCTFail(@"unexpected reject %@", code);
        });
    [self waitForExpectations:@[ done ] timeout:2];
    XCTAssertEqual(settles, 1);
    XCTAssertEqual(value, outcome.boolValue);
  }
}

- (void)testASlowCompletionPastTheOldOneAndAHalfSecondDeadlineStillResolvesItsOutcome {
  XCTestExpectation *done = [self expectationWithDescription:@"resolved late"];
  dispatch_queue_t queue = [self queue];
  __block BOOL value = NO;
  BGSRNDeleteCollectedData(
      ^(void (^completion)(BOOL)) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC),
                       dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                         completion(YES);
                       });
      },
      5000, queue,
      ^(BOOL success) {
        value = success;
        [done fulfill];
      },
      ^(NSString *code) {
        XCTFail(@"unexpected reject %@", code);
      });
  [self waitForExpectations:@[ done ] timeout:3];
  XCTAssertTrue(value);
}

- (void)testRejectsWithATimeoutCodeWhenTheCompletionNeverComes {
  XCTestExpectation *done = [self expectationWithDescription:@"rejected"];
  __block NSString *rejectedCode = nil;
  BGSRNDeleteCollectedData(
      ^(void (^completion)(BOOL)) {
      },
      50, [self queue],
      ^(BOOL success) {
        XCTFail(@"must not resolve");
      },
      ^(NSString *code) {
        rejectedCode = code;
        [done fulfill];
      });
  [self waitForExpectations:@[ done ] timeout:2];
  XCTAssertEqualObjects(rejectedCode, @"E_DELETE_TIMEOUT");
  XCTAssertEqualObjects(BGSRNDeleteTimeoutCode, @"E_DELETE_TIMEOUT");
  XCTAssertEqual(BGSRNDeleteCollectedDataBackstopMs, 60000);
}

- (void)testALateCompletionAfterTheBackstopIsIgnored {
  XCTestExpectation *rejected = [self expectationWithDescription:@"rejected"];
  __block void (^lateCompletion)(BOOL) = nil;
  __block NSInteger settles = 0;
  dispatch_queue_t queue = [self queue];
  BGSRNDeleteCollectedData(
      ^(void (^completion)(BOOL)) {
        lateCompletion = [completion copy];
      },
      50, queue,
      ^(BOOL success) {
        settles += 1;
      },
      ^(NSString *code) {
        settles += 1;
        [rejected fulfill];
      });
  [self waitForExpectations:@[ rejected ] timeout:2];
  lateCompletion(YES);
  lateCompletion(NO);
  XCTestExpectation *drained = [self expectationWithDescription:@"queue drained"];
  dispatch_async(queue, ^{
    [drained fulfill];
  });
  [self waitForExpectations:@[ drained ] timeout:2];
  XCTAssertEqual(settles, 1);
}

- (void)testASecondCompletionIsIgnored {
  XCTestExpectation *done = [self expectationWithDescription:@"resolved"];
  __block NSInteger settles = 0;
  dispatch_queue_t queue = [self queue];
  BGSRNDeleteCollectedData(
      ^(void (^completion)(BOOL)) {
        completion(YES);
        completion(NO);
      },
      5000, queue,
      ^(BOOL success) {
        settles += 1;
        XCTAssertTrue(success);
      },
      ^(NSString *code) {
        XCTFail(@"unexpected reject");
      });
  dispatch_async(queue, ^{
    [done fulfill];
  });
  [self waitForExpectations:@[ done ] timeout:2];
  XCTAssertEqual(settles, 1);
}

@end
