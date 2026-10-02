@import XCTest;
@import UIKit;
@import BugseeRNSupport;

#import "BGSRNSecureOriginTestSupport.h"

/// The tracker records where the React root's window sits on the screen, so
/// the SDK gets JS's window-point rectangles where it draws them. What it must
/// never do is guess -- a made-up origin moves every region off its view --
/// or walk every window on each of the SDK's pulls.
@interface BGSRNReactRootOriginTrackerTests : XCTestCase
@end

@implementation BGSRNReactRootOriginTrackerTests {
  BGSRNSecureRectangles *_store;
  UIWindow *_window;
  UIView *_root;
  NSUInteger _searches;
  NSValue *_origin;
}

- (void)setUp {
  [super setUp];
  _store = [[BGSRNSecureRectangles alloc] init];
  _window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 100, 100)];
  _root = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 10, 10)];
  [_window addSubview:_root];
  _searches = 0;
  _origin = [NSValue valueWithCGPoint:CGPointMake(100, 50)];
  const int32_t rects[] = {10, 20, 30, 40};
  [_store setCoordinates:rects count:4 forDisplay:0];
}

/// Finds `_root` (or nothing once it is nil) and reads `_origin` for the
/// window it is in, counting the searches.
- (BGSRNReactRootOriginTracker *)tracker {
  __weak __typeof(self) weakSelf = self;
  return [[BGSRNReactRootOriginTracker alloc] initWithStore:_store
      findRoot:^UIView * {
        __typeof(self) strongSelf = weakSelf;
        strongSelf->_searches += 1;
        return strongSelf->_root;
      }
      readOrigin:^NSValue *(UIWindow *window) {
        __typeof(self) strongSelf = weakSelf;
        return window == strongSelf->_root.window ? strongSelf->_origin : nil;
      }];
}

- (NSArray<NSNumber *> *)served {
  return BGSRNServedCoordinates([_store snapshotForDisplay:0]);
}

- (void)testRecordsTheWindowsPlaceForDisplayZero {
  [[self tracker] refreshFindingTheRoot];

  XCTAssertEqualObjects([self served], (@[@110, @70, @130, @90]));
}

/// The SDK pulls ten times a second on the main thread. With no React root on
/// screen (a brownfield app's native screens) a search there would walk every
/// window to its budget each time.
- (void)testAPullNeverSearches {
  BGSRNReactRootOriginTracker *tracker = [self tracker];

  [tracker refresh];
  [tracker refresh];

  XCTAssertEqual(_searches, 0u);
  XCTAssertEqualObjects([self served], (@[@10, @20, @30, @40]));
}

/// A window dragged across the screen: the pull re-reads its place through
/// the root it already has.
- (void)testAPullFollowsTheWindowOfTheRootFoundLast {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker refreshFindingTheRoot];

  _origin = [NSValue valueWithCGPoint:CGPointMake(200, 80)];
  [tracker refresh];

  XCTAssertEqualObjects([self served], (@[@210, @100, @230, @120]));
  XCTAssertEqual(_searches, 1u);
}

- (void)testAPublishDoesNotSearchWhileTheRootIsInAWindow {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker refreshFindingTheRoot];

  [tracker refreshFindingTheRoot];

  XCTAssertEqual(_searches, 1u);
}

/// A reload replaces the root; the next publish finds the new one.
- (void)testAPublishSearchesAgainOnceTheRootHasLeftItsWindow {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker refreshFindingTheRoot];
  [_root removeFromSuperview];
  _root = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 10, 10)];
  [_window addSubview:_root];

  [tracker refreshFindingTheRoot];

  XCTAssertEqual(_searches, 2u);
  XCTAssertEqualObjects([self served], (@[@110, @70, @130, @90]));
}

/// A window off its screen for a moment (a scene disconnecting) must not
/// throw the regions back to the window's own corner.
- (void)testKeepsTheLastOriginWhenThePlaceCannotBeRead {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker refreshFindingTheRoot];

  _origin = nil;
  [tracker refresh];

  XCTAssertEqualObjects([self served], (@[@110, @70, @130, @90]));
}

- (void)testKeepsTheLastOriginWhenNoRootIsFound {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker refreshFindingTheRoot];
  [_root removeFromSuperview];
  _root = nil;

  [tracker refreshFindingTheRoot];

  XCTAssertEqualObjects([self served], (@[@110, @70, @130, @90]));
}

/// They run inside the SDK's pull, where an exception would take the host
/// app down over a redaction offset.
- (void)testSwallowsAnExceptionFromTheSearch {
  BGSRNReactRootOriginTracker *tracker =
      [[BGSRNReactRootOriginTracker alloc] initWithStore:_store
                                                findRoot:^UIView * {
                                                  [NSException raise:@"Test" format:@"search"];
                                                  return nil;
                                                }
                                              readOrigin:^NSValue *(UIWindow *window) {
                                                return nil;
                                              }];

  XCTAssertNoThrow([tracker refreshFindingTheRoot]);
}

- (void)testSwallowsAnExceptionFromReadingThePlace {
  UIView *root = _root;
  BGSRNReactRootOriginTracker *tracker =
      [[BGSRNReactRootOriginTracker alloc] initWithStore:_store
                                                findRoot:^UIView * {
                                                  return root;
                                                }
                                              readOrigin:^NSValue *(UIWindow *window) {
                                                [NSException raise:@"Test" format:@"read"];
                                                return nil;
                                              }];

  XCTAssertNoThrow([tracker refreshFindingTheRoot]);
  XCTAssertEqualObjects([self served], (@[@10, @20, @30, @40]));
}

@end
