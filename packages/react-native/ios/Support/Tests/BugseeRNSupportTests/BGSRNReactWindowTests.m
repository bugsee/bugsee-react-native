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
/// What `RCTModalHostViewComponentView` presents its content in.
@property (nonatomic, strong, nullable) UIViewController *viewController;
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

  UIView *found = BGSRNUniqueTaggedView(@[ window ], 42, [self isModalHost], BGSRNModalHostSearchBudget);

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

  XCTAssertEqual(BGSRNUniqueTaggedView(@[ window ], 7, [self isModalHost], BGSRNModalHostSearchBudget), host);
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

  XCTAssertEqual(BGSRNUniqueTaggedView(@[ first, second ], 42, [self isModalHost], BGSRNModalHostSearchBudget), host);
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

  XCTAssertNil(BGSRNUniqueTaggedView(@[ window ], 42, [self isModalHost], BGSRNModalHostSearchBudget));
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
  XCTAssertNil(BGSRNUniqueTaggedView(@[ window ], 42, [self isModalHost], 6));
  XCTAssertEqual(BGSRNUniqueTaggedView(@[ window ], 42, [self isModalHost], 7), host);
}

#pragma mark - Which host places a <Modal> lane (PR 48, round 2)

/// A host with `tag`, presenting its content at `contentFrame` inside
/// `window` when `presentedIn` is non-nil (a stand-in for a presented view
/// controller: its view is in a window), not presented otherwise.
- (BGSRNFakeModalHost *)hostTagged:(NSInteger)tag
                          inWindow:(UIWindow *)window
                       presentedIn:(nullable UIWindow *)presentedIn
                      contentFrame:(CGRect)contentFrame {
  BGSRNFakeModalHost *host = [BGSRNFakeModalHost new];
  host.tag = tag;
  [window addSubview:host];
  UIViewController *controller = [UIViewController new];
  controller.view.frame = contentFrame;
  if (presentedIn != nil) {
    [presentedIn addSubview:controller.view];
  }
  host.viewController = controller;
  return host;
}

- (BGSRNSecureRectangles *)storeWithLaneOn:(NSInteger)surface claim:(NSInteger *)claim {
  BGSRNSecureRectangles *store = [[BGSRNSecureRectangles alloc] init];
  const NSInteger current = [store claimRuntime];
  const int32_t rects[] = {1, 2, 3, 4};
  XCTAssertTrue([store setCoordinates:rects count:4 forDisplay:0 surface:surface runtime:current]);
  if (claim != NULL) {
    *claim = current;
  }
  return store;
}

- (void)testTheHostOriginIsThePresentedContentInItsWindowPlusTheWindowsOrigin {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(10, 20, 390, 844)];
  BGSRNFakeModalHost *host = [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 60, 390, 784)];

  XCTAssertEqualObjects(BGSRNModalHostOrigin(host), [NSValue valueWithCGPoint:CGPointMake(10, 80)]);
}

- (void)testAHostWhoseContentHasNoWindowHasNoOrigin {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  BGSRNFakeModalHost *host = [self hostTagged:42 inWindow:window presentedIn:nil contentFrame:CGRectMake(0, 60, 390, 784)];

  XCTAssertNil(BGSRNModalHostOrigin(host));
  XCTAssertNil(BGSRNModalHostOrigin([UIView new]));
}

/// What a module's view registry answers: `host` for `tag`, nothing else.
- (BGSRNSecureHostResolver)registryWith:(UIView *)host calls:(NSUInteger *)calls {
  __weak UIView *weakHost = host;
  return ^id _Nullable(NSInteger tag) {
    if (calls != NULL) {
      *calls += 1;
    }
    return tag == weakHost.tag ? weakHost : nil;
  };
}

/// Two hosts with tag 42, only the second presented and the current
/// runtime's: the origin comes from the second, though the walk meets the
/// first one first.
- (void)testTheOriginComesFromTheCurrentRuntimesHost {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:window presentedIn:nil contentFrame:CGRectMake(0, 300, 390, 544)];
  BGSRNFakeModalHost *current = [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 60, 390, 784)];
  NSInteger claim = 0;
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:&claim];
  XCTAssertTrue([store setHostResolver:[self registryWith:current calls:NULL] forSurface:42 runtime:claim]);

  NSValue *origin = BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]);

  XCTAssertEqualObjects(origin, [NSValue valueWithCGPoint:CGPointMake(0, 60)]);
}

/// The host is mounted after the publish that names it: the lookup is asked
/// on each pull until it finds the host, which is then held, not looked up
/// again.
- (void)testTheLookupIsAskedUntilTheHostIsMountedThenTheHostIsHeld {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  NSInteger claim = 0;
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:&claim];
  __block UIView *mounted = nil;
  __block NSUInteger calls = 0;
  [store setHostResolver:^id _Nullable(NSInteger tag) {
    calls += 1;
    return mounted;
  }
              forSurface:42
                 runtime:claim];

  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]));
  XCTAssertEqual(calls, 1u);

  mounted = [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 60, 390, 784)];
  XCTAssertEqualObjects(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]),
                        [NSValue valueWithCGPoint:CGPointMake(0, 60)]);
  XCTAssertEqualObjects(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]),
                        [NSValue valueWithCGPoint:CGPointMake(0, 60)]);
  XCTAssertEqual(calls, 2u);
}

/// What the registry answers must be a Modal host with the surface's tag.
- (void)testALookupAnswerThatIsNotAModalHostIsNotUsed {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  UIView *plain = [UIView new];
  plain.tag = 42;
  [window addSubview:plain];
  NSInteger claim = 0;
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:&claim];
  [store setHostResolver:^id _Nullable(NSInteger tag) {
    return plain;
  }
              forSurface:42
                 runtime:claim];

  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]));
  XCTAssertNil([store hostForSurface:42 accepting:^BOOL(id candidate) { return NO; }]);
}

/// A reload with a sheet up: after the new runtime claims, the old host's
/// origin is never used, though it is still presented with the same tag.
- (void)testAfterAClaimTheOldHostsOriginIsNeverUsed {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  BGSRNFakeModalHost *old = [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 300, 390, 544)];
  NSInteger oldClaim = 0;
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:&oldClaim];
  XCTAssertTrue([store setHostResolver:[self registryWith:old calls:NULL] forSurface:42 runtime:oldClaim]);
  XCTAssertEqualObjects(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]),
                        [NSValue valueWithCGPoint:CGPointMake(0, 300)]);

  const NSInteger current = [store claimRuntime];
  XCTAssertNil([store hostForSurface:42 accepting:^BOOL(id candidate) { return YES; }],
               @"a claim forgets every host and lookup");
  const int32_t rects[] = {1, 2, 3, 4};
  [store setCoordinates:rects count:4 forDisplay:0 surface:42 runtime:current];
  BGSRNFakeModalHost *fresh = [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 0, 390, 844)];

  // Before the new module names its host: two matches, so no origin.
  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]));
  // The old module's late naming is stale.
  XCTAssertFalse([store setHostResolver:[self registryWith:old calls:NULL] forSurface:42 runtime:oldClaim]);
  XCTAssertFalse([store setHost:old forSurface:42 runtime:oldClaim]);
  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]));
  // The new module's lookup places the lane by its own host.
  XCTAssertTrue([store setHostResolver:[self registryWith:fresh calls:NULL] forSurface:42 runtime:current]);
  XCTAssertEqualObjects(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]),
                        [NSValue valueWithCGPoint:CGPointZero]);
}

/// The fallback walk cannot tell two hosts with one tag apart: no origin,
/// even when only one is presented.
- (void)testTwoWalkMatchesGiveNoOrigin {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 300, 390, 544)];
  UIWindow *other = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:other presentedIn:nil contentFrame:CGRectMake(0, 60, 390, 784)];
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:NULL];

  XCTAssertNil(BGSRNUniqueTaggedView(@[ window, other ], 42, [self isModalHost], BGSRNModalHostSearchBudget));
  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window, other ], [self isModalHost]));
  XCTAssertEqualObjects(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]),
                        [NSValue valueWithCGPoint:CGPointMake(0, 300)]);
}

/// The one walk match whose content has no window gives no origin.
- (void)testAWalkMatchThatIsNotPresentedGivesNoOrigin {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:window presentedIn:nil contentFrame:CGRectMake(0, 60, 390, 784)];
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:NULL];

  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]));
}

/// A held host that has gone is looked up again; the lookup not finding it
/// leaves the origin unknown, not a search that could find another host.
- (void)testAGoneHostTheLookupCannotFindGivesNoOrigin {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 300, 390, 544)];
  NSInteger claim = 0;
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:&claim];
  __block NSUInteger calls = 0;
  @autoreleasepool {
    BGSRNFakeModalHost *gone = [BGSRNFakeModalHost new];
    gone.tag = 42;
    XCTAssertTrue([store setHost:gone forSurface:42 runtime:claim]);
    [store setHostResolver:^id _Nullable(NSInteger tag) {
      calls += 1;
      return nil;
    }
                forSurface:42
                   runtime:claim];
  }

  XCTAssertNil(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]));
  XCTAssertEqual(calls, 1u);
}

/// A reload with a sheet up, before the new runtime's Modal has mounted: the
/// old runtime's presented host is the only one with tag 42, and the new
/// runtime has named its lookup, which finds nothing yet. The old host's
/// origin must not place the new lane: it stays unknown and is served as the
/// whole display.
- (void)testAnOldHostAloneWhileTheNewHostIsNotMountedGivesNoOrigin {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 300, 390, 544)];
  BGSRNSecureRectangles *store = [[BGSRNSecureRectangles alloc] init];
  [store setDisplaySize:CGSizeMake(390, 844) forDisplay:0];
  [store setOrigin:CGPointZero forDisplay:0];
  [store claimRuntime];
  const NSInteger current = [store claimRuntime];
  const int32_t rects[] = {10, 20, 110, 120};
  XCTAssertTrue([store setCoordinates:rects count:4 forDisplay:0 surface:42 runtime:current]);
  XCTAssertTrue([store setHostResolver:^id _Nullable(NSInteger tag) {
    return nil;
  }
                            forSurface:42
                               runtime:current]);
  XCTAssertNotNil(BGSRNUniqueTaggedView(@[ window ], 42, [self isModalHost], BGSRNModalHostSearchBudget),
                  @"the fixture's old host is the walk's one match");

  NSValue *origin = BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]);

  XCTAssertNil(origin);
  // What the pull then serves: the lane's origin is still unknown.
  NSData *snapshot = [store snapshotForDisplay:0];
  int32_t served[6] = {0};
  [snapshot getBytes:served length:sizeof(served)];
  XCTAssertEqual(CFSwapInt32LittleToHost((uint32_t)served[1]), 1u);
  XCTAssertEqual((int32_t)CFSwapInt32LittleToHost((uint32_t)served[2]), 0);
  XCTAssertEqual((int32_t)CFSwapInt32LittleToHost((uint32_t)served[3]), 0);
  XCTAssertEqual((int32_t)CFSwapInt32LittleToHost((uint32_t)served[4]), 390);
  XCTAssertEqual((int32_t)CFSwapInt32LittleToHost((uint32_t)served[5]), 844);
}

/// With no lookup ever named (no registry), the walk's one presented match
/// places the lane.
- (void)testWithNoLookupNamedTheUniqueWalkPlacesTheLane {
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 390, 844)];
  [self hostTagged:42 inWindow:window presentedIn:window contentFrame:CGRectMake(0, 300, 390, 544)];
  BGSRNSecureRectangles *store = [self storeWithLaneOn:42 claim:NULL];

  XCTAssertFalse([store isHostNamedForSurface:42]);
  XCTAssertEqualObjects(BGSRNSecureSurfaceOrigin(store, 42, @[ window ], [self isModalHost]),
                        [NSValue valueWithCGPoint:CGPointMake(0, 300)]);
}

@end
