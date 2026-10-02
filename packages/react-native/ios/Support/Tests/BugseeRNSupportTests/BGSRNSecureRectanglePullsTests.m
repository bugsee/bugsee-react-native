@import XCTest;
@import BugseeRNSupport;

#import "BGSRNSecureOriginTestSupport.h"

/// The SDK pulls 2-3 times a second, more while capturing. Each pull keeps the
/// window's place fresh -- a window moves with nothing published -- but no
/// more often than every 100 ms, and it always gets its rectangles.
@interface BGSRNSecureRectanglePullsTests : XCTestCase
@end

@implementation BGSRNSecureRectanglePullsTests {
  BGSRNSecureRectangles *_store;
  BGSRNSecureRectanglePulls *_pulls;
  NSTimeInterval _now;
  NSUInteger _refreshes;
}

- (void)setUp {
  [super setUp];
  _store = [[BGSRNSecureRectangles alloc] init];
  _now = 1000;
  _refreshes = 0;
  __weak __typeof(self) weakSelf = self;
  _pulls = [[BGSRNSecureRectanglePulls alloc] initWithStore:_store
                                                      clock:^NSTimeInterval {
                                                        __typeof(self) strongSelf = weakSelf;
                                                        return strongSelf ? strongSelf->_now : 0;
                                                      }];
  _pulls.refresher = ^{
    __typeof(self) strongSelf = weakSelf;
    if (strongSelf) {
      strongSelf->_refreshes += 1;
    }
  };
  const int32_t rects[] = {10, 20, 30, 40};
  [_store setCoordinates:rects count:4 forDisplay:0];
}

- (void)testTheFirstPullRefreshes {
  [_pulls pullForDisplay:0];

  XCTAssertEqual(_refreshes, 1u);
}

- (void)testAPullInsideTheIntervalDoesNotRefreshAgain {
  [_pulls pullForDisplay:0];
  _now += BGSRNOriginRefreshMinInterval / 2;

  [_pulls pullForDisplay:0];

  XCTAssertEqual(_refreshes, 1u);
}

- (void)testAPullOnceTheIntervalHasPassedRefreshesAgain {
  [_pulls pullForDisplay:0];
  _now += BGSRNOriginRefreshMinInterval;

  [_pulls pullForDisplay:0];

  XCTAssertEqual(_refreshes, 2u);
}

/// On the main thread the refresh lands before the snapshot is taken, so a
/// window that just moved is already served at its new place.
- (void)testServesTheOriginTheRefreshRecorded {
  BGSRNSecureRectangles *store = _store;
  _pulls.refresher = ^{
    [store setOrigin:CGPointMake(100, 50) forDisplay:0];
  };

  NSData *packed = [_pulls pullForDisplay:0];

  XCTAssertEqualObjects(BGSRNServedCoordinates(packed), (@[@110, @70, @130, @90]));
}

- (void)testServesTheRectanglesWithNoRefresher {
  _pulls.refresher = nil;

  XCTAssertEqualObjects(BGSRNServedCoordinates([_pulls pullForDisplay:0]),
                        (@[@10, @20, @30, @40]));
}

/// The pull is the SDK's, on its frame path: a refresher that throws must not
/// cost it the rectangles.
- (void)testServesTheRectanglesWhenTheRefresherThrows {
  _pulls.refresher = ^{
    [NSException raise:@"Test" format:@"refresh"];
  };

  NSData *packed = nil;
  XCTAssertNoThrow(packed = [_pulls pullForDisplay:0]);
  XCTAssertEqualObjects(BGSRNServedCoordinates(packed), (@[@10, @20, @30, @40]));
}

/// Every pull the SDK makes today is on the main thread; one that is not must
/// not read UIKit there. The refresh is posted to main, and a later pull
/// serves it.
- (void)testAPullOffTheMainThreadRefreshesOnMainForALaterPull {
  BGSRNSecureRectangles *store = _store;
  XCTestExpectation *refreshed = [self expectationWithDescription:@"refreshed"];
  XCTestExpectation *pulled = [self expectationWithDescription:@"pulled off main"];
  __block BOOL refreshedOnMain = NO;
  _pulls.refresher = ^{
    refreshedOnMain = NSThread.isMainThread;
    [store setOrigin:CGPointMake(100, 50) forDisplay:0];
    [refreshed fulfill];
  };

  BGSRNSecureRectanglePulls *pulls = _pulls;
  // Async, not sync: GCD may run a sync block on the calling (main) thread.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    XCTAssertFalse(NSThread.isMainThread);
    [pulls pullForDisplay:0];
    [pulled fulfill];
  });
  [self waitForExpectations:@[ pulled, refreshed ] timeout:2];

  XCTAssertTrue(refreshedOnMain, @"the refresh reads UIKit, so it must run on main");
  XCTAssertEqualObjects(BGSRNServedCoordinates([_pulls pullForDisplay:0]),
                        (@[@110, @70, @130, @90]));
}

- (void)testSharedPullsAreOneInstance {
  XCTAssertTrue(BGSRNSecureRectanglePulls.shared == BGSRNSecureRectanglePulls.shared);
}

@end
