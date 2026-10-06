@import XCTest;
@import UIKit;
@import BugseeRNSupport;

/// The tracker gives where the React root's window sits on the screen, so the
/// main surface's secure rectangles and the `vh` tree land where the SDK draws.
/// What it must never do is guess -- a made-up origin moves every region off
/// its view -- or walk every window on each of the SDK's pulls, which come
/// once per captured frame.
@interface BGSRNReactRootOriginTrackerTests : XCTestCase
@end

@implementation BGSRNReactRootOriginTrackerTests {
  UIWindow *_window;
  UIView *_root;
  NSUInteger _searches;
  NSValue *_origin;
  NSTimeInterval _now;
}

- (void)setUp {
  [super setUp];
  _window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 100, 100)];
  _root = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 10, 10)];
  [_window addSubview:_root];
  _searches = 0;
  _origin = [NSValue valueWithCGPoint:CGPointMake(100, 50)];
  _now = 1000;
}

/// Finds `_root` (or nothing once it is nil) and reads `_origin` for the
/// window it is in, counting the searches, on a clock the test moves.
- (BGSRNReactRootOriginTracker *)tracker {
  __weak __typeof(self) weakSelf = self;
  return [[BGSRNReactRootOriginTracker alloc]
      initWithFindRoot:^UIView * {
        __typeof(self) strongSelf = weakSelf;
        strongSelf->_searches += 1;
        return strongSelf->_root;
      }
      readOrigin:^NSValue *(UIWindow *window) {
        __typeof(self) strongSelf = weakSelf;
        return window == strongSelf->_root.window ? strongSelf->_origin : nil;
      }
      clock:^NSTimeInterval {
        __typeof(self) strongSelf = weakSelf;
        return strongSelf ? strongSelf->_now : 0;
      }];
}

- (NSValue *)at:(CGFloat)x :(CGFloat)y {
  return [NSValue valueWithCGPoint:CGPointMake(x, y)];
}

- (void)testGivesTheWindowsPlace {
  XCTAssertEqualObjects([[self tracker] originFindingTheRoot], [self at:100 :50]);
}

/// A window dragged across the screen: a pull re-reads its place through the
/// root it already has, without a search.
- (void)testAPullFollowsTheWindowOfTheRootFoundLast {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker originFindingTheRoot];

  _origin = [self at:200 :80];

  XCTAssertEqualObjects([tracker origin], [self at:200 :80]);
  XCTAssertEqual(_searches, 1u);
}

/// The SDK pulls once per captured frame on the main thread. With no React
/// root on screen (a brownfield app's native screens) a search on each pull
/// would walk every window to its budget each time.
- (void)testPullsWithNoRootSearchAtMostOncePerInterval {
  _root = nil;
  BGSRNReactRootOriginTracker *tracker = [self tracker];

  XCTAssertNil([tracker origin]);
  XCTAssertNil([tracker origin]);
  _now += BGSRNReactRootSearchMinInterval / 2;
  XCTAssertNil([tracker origin]);
  XCTAssertEqual(_searches, 1u);

  _now += BGSRNReactRootSearchMinInterval;
  XCTAssertNil([tracker origin]);
  XCTAssertEqual(_searches, 2u);
}

/// A pull still finds a root that was not there before, at the next interval:
/// a main surface with rectangles and no origin serves the whole screen.
- (void)testAPullFindsARootThatAppearedLater {
  UIView *root = _root;
  _root = nil;
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  XCTAssertNil([tracker origin]);

  _root = root;
  _now += BGSRNReactRootSearchMinInterval;

  XCTAssertEqualObjects([tracker origin], [self at:100 :50]);
}

/// A JS publish or a `vh` request does not wait for the interval.
- (void)testFindingTheRootSearchesAtOnce {
  UIView *root = _root;
  _root = nil;
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  XCTAssertNil([tracker origin]);

  _root = root;

  XCTAssertEqualObjects([tracker originFindingTheRoot], [self at:100 :50]);
  XCTAssertEqual(_searches, 2u);
}

- (void)testDoesNotSearchWhileTheRootIsInAWindow {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker originFindingTheRoot];

  [tracker originFindingTheRoot];
  [tracker origin];

  XCTAssertEqual(_searches, 1u);
}

/// A reload replaces the root; the next search finds the new one.
- (void)testSearchesAgainOnceTheRootHasLeftItsWindow {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker originFindingTheRoot];
  [_root removeFromSuperview];
  _root = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 10, 10)];
  [_window addSubview:_root];

  XCTAssertEqualObjects([tracker originFindingTheRoot], [self at:100 :50]);
  XCTAssertEqual(_searches, 2u);
}

/// A window off its screen for a moment (a scene disconnecting) has no place:
/// nil, and the caller keeps the origin it has rather than serve the regions
/// at the window's own corner.
- (void)testNoOriginWhenThePlaceCannotBeRead {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  [tracker originFindingTheRoot];

  _origin = nil;

  XCTAssertNil([tracker origin]);
}

- (void)testNoOriginWhenNoRootIsFound {
  _root = nil;

  XCTAssertNil([[self tracker] originFindingTheRoot]);
}

/// The tracker keeps the root weakly: a reload's old root must go.
- (void)testDoesNotKeepTheRootAlive {
  BGSRNReactRootOriginTracker *tracker = [self tracker];
  __weak UIView *weakRoot = nil;
  @autoreleasepool {
    UIView *root = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 10, 10)];
    [_window addSubview:root];
    _root = root;
    weakRoot = root;
    [tracker originFindingTheRoot];
    [root removeFromSuperview];
    _root = nil;
  }

  XCTAssertNil(weakRoot);
}

/// They run inside the SDK's pull, where an exception would take the host
/// app down over a redaction offset.
- (void)testSwallowsAnExceptionFromTheSearch {
  BGSRNReactRootOriginTracker *tracker = [[BGSRNReactRootOriginTracker alloc]
      initWithFindRoot:^UIView * {
        [NSException raise:@"Test" format:@"search"];
        return nil;
      }
      readOrigin:^NSValue *(UIWindow *window) {
        return nil;
      }
      clock:^NSTimeInterval {
        return 0;
      }];

  XCTAssertNoThrow([tracker originFindingTheRoot]);
  XCTAssertNil([tracker originFindingTheRoot]);
}

- (void)testSwallowsAnExceptionFromReadingThePlace {
  UIView *root = _root;
  BGSRNReactRootOriginTracker *tracker = [[BGSRNReactRootOriginTracker alloc]
      initWithFindRoot:^UIView * {
        return root;
      }
      readOrigin:^NSValue *(UIWindow *window) {
        [NSException raise:@"Test" format:@"read"];
        return nil;
      }
      clock:^NSTimeInterval {
        return 0;
      }];

  XCTAssertNoThrow([tracker originFindingTheRoot]);
  XCTAssertNil([tracker originFindingTheRoot]);
}

@end
