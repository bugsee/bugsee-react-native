@import XCTest;
@import UIKit;
@import BugseeRNSupport;

/// Stands in for `RCTSurfaceHostingView`; the module's predicate matches the
/// real class by name.
@interface BGSRNFakeReactRoot : UIView
@end

@implementation BGSRNFakeReactRoot
@end

/// Stands in for `RCTModalHostViewComponentView`; the module's predicate
/// matches the real class by name.
@interface BGSRNFakeModalHost : UIView
@end

@implementation BGSRNFakeModalHost
@end

/// The `vh` origin must be the offset the SDK itself adds to every native
/// node -- the hosting window's `frame.origin`
/// (`BGSCaptureViewHierarchyEngine.m:334-336`) -- so the React tree and the
/// native tree share one space by construction.
@interface BGSRNReactWindowTests : XCTestCase
@end

@implementation BGSRNReactWindowTests {
  BOOL (^_isReactRoot)(UIView *);
}

- (void)setUp {
  [super setUp];
  _isReactRoot = ^BOOL(UIView *view) {
    return [view isKindOfClass:BGSRNFakeReactRoot.class];
  };
}

- (UIWindow *)windowAt:(CGRect)frame hostingAtDepth:(NSUInteger)depth {
  UIWindow *window = [[UIWindow alloc] initWithFrame:frame];
  if (depth == NSNotFound) {
    [window addSubview:[UIView new]];
    return window;
  }
  UIView *parent = window;
  for (NSUInteger i = 0; i < depth; i++) {
    UIView *child = [UIView new];
    [parent addSubview:child];
    parent = child;
  }
  [parent addSubview:[BGSRNFakeReactRoot new]];
  return window;
}

- (void)testTheOriginIsTheHostingWindowsFrameOrigin {
  UIWindow *key = [self windowAt:CGRectMake(0, 0, 390, 844) hostingAtDepth:NSNotFound];
  UIWindow *hosting = [self windowAt:CGRectMake(120.5, 64, 300, 400) hostingAtDepth:3];

  NSValue *origin = BGSRNReactRootOrigin(key, @[ key, hosting ], _isReactRoot);

  XCTAssertEqualObjects(origin, [NSValue valueWithCGPoint:CGPointMake(120.5, 64)]);
}

/// What JS computes (`measureInWindow` + origin) is what the SDK computes for
/// the same view (window-relative rect + `window.frame.origin`).
- (void)testANodePlusTheOriginLandsWhereTheSdkPutsIt {
  UIWindow *window = [self windowAt:CGRectMake(40, 30, 300, 400) hostingAtDepth:0];
  UIView *container = [[UIView alloc] initWithFrame:CGRectMake(10, 20, 200, 200)];
  UIView *view = [[UIView alloc] initWithFrame:CGRectMake(5, 7, 50, 60)];
  [container addSubview:view];
  [window addSubview:container];

  const CGPoint origin = BGSRNReactRootOrigin(window, @[ window ], _isReactRoot).CGPointValue;
  const CGRect inWindow = [view convertRect:view.bounds toView:nil];
  CGRect sdk = [view.window convertRect:view.frame fromView:view.superview];
  sdk.origin.x += view.window.frame.origin.x;
  sdk.origin.y += view.window.frame.origin.y;

  XCTAssertEqual(inWindow.origin.x + origin.x, sdk.origin.x);
  XCTAssertEqual(inWindow.origin.y + origin.y, sdk.origin.y);
  XCTAssertEqual(sdk.origin.x, 55);
  XCTAssertEqual(sdk.origin.y, 57);
}

/// Not the window's position in the screen's coordinate space, which can
/// differ from `frame.origin` (iPad multitasking; here, a transformed window,
/// the one case a unit test can construct): the SDK adds `frame.origin`.
- (void)testTheOriginIsTheFrameOriginNotTheScreenSpacePosition {
  UIWindow *window = [self windowAt:CGRectMake(10, 20, 100, 200) hostingAtDepth:0];
  window.transform = CGAffineTransformMakeRotation(M_PI);
  const CGPoint screenSpace = [window convertPoint:CGPointZero toCoordinateSpace:window.screen.coordinateSpace];
  XCTAssertFalse(CGPointEqualToPoint(screenSpace, window.frame.origin), @"the fixture must tell the two apart");

  NSValue *origin = BGSRNReactRootOrigin(window, @[ window ], _isReactRoot);

  XCTAssertEqualObjects(origin, [NSValue valueWithCGPoint:window.frame.origin]);
}

- (void)testTheKeyWindowIsPreferredWhenSeveralHost {
  UIWindow *other = [self windowAt:CGRectMake(1, 2, 10, 10) hostingAtDepth:0];
  UIWindow *key = [self windowAt:CGRectMake(3, 4, 10, 10) hostingAtDepth:0];

  XCTAssertEqual(BGSRNWindowHostingReactRoot(key, @[ other, key ], _isReactRoot, BGSRNReactRootSearchBudget), key);
}

/// The SDK walks the key window even when its scene list lacks it.
- (void)testTheKeyWindowIsSearchedEvenIfNotInTheList {
  UIWindow *key = [self windowAt:CGRectMake(3, 4, 10, 10) hostingAtDepth:1];

  XCTAssertEqual(BGSRNWindowHostingReactRoot(key, @[], _isReactRoot, BGSRNReactRootSearchBudget), key);
}

- (void)testNoHostingWindowIsNoOrigin {
  UIWindow *key = [self windowAt:CGRectMake(0, 0, 10, 10) hostingAtDepth:NSNotFound];

  XCTAssertNil(BGSRNReactRootOrigin(key, @[ key ], _isReactRoot));
  XCTAssertNil(BGSRNReactRootOrigin(nil, @[], _isReactRoot));
}

- (void)testTheSearchIsBoundedPerWindow {
  UIWindow *deep = [self windowAt:CGRectMake(0, 0, 10, 10) hostingAtDepth:5];

  // The window, 5 plain views, then the root: the 7th view inspected.
  XCTAssertNil(BGSRNWindowHostingReactRoot(deep, @[], _isReactRoot, 6));
  XCTAssertEqual(BGSRNWindowHostingReactRoot(deep, @[], _isReactRoot, 7), deep);
}

- (void)testTheSdkWalkedWindowsAreEmptyWithoutAKeyWindow {
  XCTAssertEqualObjects(BGSRNSdkWalkedWindows(nil), @[]);
}

#pragma mark - The <Modal> host by React tag (PR 48)

- (BOOL (^)(UIView *))isModalHost {
  return ^BOOL(UIView *view) {
    return [view isKindOfClass:BGSRNFakeModalHost.class];
  };
}

/// A native view with the host's tag, earlier in the same window, is what
/// `viewWithTag:` returns; the walk must keep going and find the host.
- (void)testANativeViewWithTheSameTagBeforeTheHostStillFindsTheHost {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  UIView *dummy = [UIView new];
  dummy.tag = 42;
  [window addSubview:dummy];
  UIView *container = [UIView new];
  [window addSubview:container];
  BGSRNFakeModalHost *host = [BGSRNFakeModalHost new];
  host.tag = 42;
  [container addSubview:host];
  XCTAssertEqual([window viewWithTag:42], dummy, @"the fixture must put the dummy first");

  UIView *found = BGSRNTaggedView(@[ window ], 42, [self isModalHost], BGSRNModalHostSearchBudget);

  XCTAssertEqual(found, host);
}

/// Same when the dummy is the host's own ancestor.
- (void)testAnAncestorWithTheSameTagStillFindsTheHost {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  UIView *dummy = [UIView new];
  dummy.tag = 7;
  [window addSubview:dummy];
  BGSRNFakeModalHost *host = [BGSRNFakeModalHost new];
  host.tag = 7;
  [dummy addSubview:host];

  XCTAssertEqual(BGSRNTaggedView(@[ window ], 7, [self isModalHost], BGSRNModalHostSearchBudget), host);
}

/// A wrong-class match in one window does not stop the search of the next.
- (void)testAWrongClassMatchInOneWindowStillSearchesTheNext {
  UIWindow *first = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  UIView *dummy = [UIView new];
  dummy.tag = 42;
  [first addSubview:dummy];
  UIWindow *second = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  BGSRNFakeModalHost *host = [BGSRNFakeModalHost new];
  host.tag = 42;
  [second addSubview:host];

  XCTAssertEqual(BGSRNTaggedView(@[ first, second ], 42, [self isModalHost], BGSRNModalHostSearchBudget), host);
}

/// The class alone is not enough: another Modal's host has another tag.
- (void)testAHostWithAnotherTagIsNotAMatch {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  BGSRNFakeModalHost *other = [BGSRNFakeModalHost new];
  other.tag = 43;
  [window addSubview:other];
  UIView *dummy = [UIView new];
  dummy.tag = 42;
  [window addSubview:dummy];

  XCTAssertNil(BGSRNTaggedView(@[ window ], 42, [self isModalHost], BGSRNModalHostSearchBudget));
}

- (void)testTheTaggedSearchIsBoundedPerWindow {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  UIView *parent = window;
  for (NSUInteger i = 0; i < 5; i++) {
    UIView *child = [UIView new];
    [parent addSubview:child];
    parent = child;
  }
  BGSRNFakeModalHost *host = [BGSRNFakeModalHost new];
  host.tag = 42;
  [parent addSubview:host];

  // The window, five levels, then the host: the seventh view visited.
  XCTAssertNil(BGSRNTaggedView(@[ window ], 42, [self isModalHost], 6));
  XCTAssertEqual(BGSRNTaggedView(@[ window ], 42, [self isModalHost], 7), host);
}

@end
