@import XCTest;
@import BugseeRNSupport;

/// The SDK PULLS this buffer 2-3 times a second — on iOS from the MAIN thread —
/// and re-reads the rectangles only when the version differs from the one it
/// saw last. Two properties follow, and both are load-bearing:
///
///  * a change MUST move the version, or the SDK goes on redacting the region
///    the app has stopped considering secret and, worse, records a newly
///    secret one in the clear until something else moves the version;
///  * a no-op write must NOT move it, or the SDK re-reads on every frame.
@interface BGSRNSecureRectanglesTests : XCTestCase
@end

@implementation BGSRNSecureRectanglesTests {
  BGSRNSecureRectangles *_store;
}

- (void)setUp {
  [super setUp];
  _store = [[BGSRNSecureRectangles alloc] init];
  // The main surface's origin read, as the first pull does: every test about
  // publishing and versions starts here. The fail-closed tests use a bare
  // store.
  [_store setOrigin:CGPointZero forDisplay:0];
  [_store setOrigin:CGPointZero forDisplay:1];
}

/// Reads the buffer as the SDK does: little-endian int32, `[version, count, …]`.
- (NSArray<NSNumber *> *)unpack:(NSData *)data {
  XCTAssertEqual(data.length % sizeof(int32_t), 0u,
                 @"the buffer must be a whole number of int32s");
  NSMutableArray *out = [NSMutableArray array];
  const NSUInteger count = data.length / sizeof(int32_t);
  for (NSUInteger i = 0; i < count; i++) {
    int32_t value = 0;
    [data getBytes:&value range:NSMakeRange(i * sizeof(int32_t), sizeof(int32_t))];
    [out addObject:@(CFSwapInt32LittleToHost((uint32_t)value))];
  }
  return out;
}

- (void)testPublishesAnEmptySetBeforeAnythingIsSecured {
  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqual(packed.count, 2u);
  XCTAssertEqualObjects(packed[1], @0);
}

- (void)testPacksVersionCountThenEachRectangle {
  const int32_t rects[] = {1, 2, 3, 4, 10, 20, 30, 40};
  [_store setCoordinates:rects count:8 forDisplay:0];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqualObjects(packed[1], @2);
  XCTAssertEqualObjects([packed subarrayWithRange:NSMakeRange(2, 8)],
                        (@[@1, @2, @3, @4, @10, @20, @30, @40]));
}

/// Not a tautology: the SDK reads raw int32s, so a host-endian write on a
/// big-endian host would be read byte-reversed and redact nowhere near the
/// intended region.
- (void)testEncodesCoordinatesLittleEndian {
  const int32_t rects[] = {0x01020304, 0, 0, 0};
  [_store setCoordinates:rects count:4 forDisplay:0];

  NSData *data = [_store snapshotForDisplay:0];
  uint8_t bytes[4] = {0};
  [data getBytes:bytes range:NSMakeRange(2 * sizeof(int32_t), 4)];
  XCTAssertEqual(bytes[0], 0x04);
  XCTAssertEqual(bytes[3], 0x01);
}

- (void)testMovesTheVersionWhenTheRectanglesChange {
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0];

  XCTAssertNotEqualObjects(before, [self unpack:[_store snapshotForDisplay:0]][0]);
}

- (void)testHoldsTheVersionWhenNothingChanges {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0];
  NSNumber *settled = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store setCoordinates:rects count:4 forDisplay:0];

  XCTAssertEqualObjects(settled, [self unpack:[_store snapshotForDisplay:0]][0]);
}

/// The dangerous case: same COUNT, different coordinates. A version keyed on
/// the number of rectangles would hold here.
- (void)testMovesTheVersionWhenOnlyTheCoordinatesChange {
  const int32_t first[] = {1, 2, 3, 4};
  [_store setCoordinates:first count:4 forDisplay:0];
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];

  const int32_t second[] = {9, 2, 3, 4};
  [_store setCoordinates:second count:4 forDisplay:0];

  XCTAssertNotEqualObjects(before, [self unpack:[_store snapshotForDisplay:0]][0]);
}

- (void)testMovesTheVersionWhenTheLastRectangleIsRemoved {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0];
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store setCoordinates:NULL count:0 forDisplay:0];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertNotEqualObjects(before, packed[0]);
  XCTAssertEqualObjects(packed[1], @0);
}

/// The freshness clock is per display, so one screen cannot stale another.
- (void)testVersionsEachDisplayIndependently {
  NSNumber *otherBefore = [self unpack:[_store snapshotForDisplay:1]][0];
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0];

  NSArray *other = [self unpack:[_store snapshotForDisplay:1]];
  XCTAssertEqualObjects(otherBefore, other[0]);
  XCTAssertEqualObjects(other[1], @0);
}

/// An immutable NSData per pull. The SDK's header is explicit that a buffer
/// rewritten from another thread while it reads is a use-after-free, and our
/// writes arrive from the JS thread while the pull is on the main one.
- (void)testHandsOutASnapshotThatCannotAliasTheStore {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0];

  NSData *first = [_store snapshotForDisplay:0];
  const int32_t changed[] = {7, 8, 9, 10};
  [_store setCoordinates:changed count:4 forDisplay:0];

  XCTAssertEqualObjects([self unpack:first][2], @1,
                        @"a snapshot already handed out must not change underneath its reader");
}

/// Four coordinates per rectangle. A truncated tail would be packed as a
/// rectangle with garbage coordinates, redacting somewhere arbitrary.
- (void)testIgnoresACoordinateListThatIsNotWholeRectangles {
  const int32_t rects[] = {1, 2, 3};
  XCTAssertFalse([_store setCoordinates:rects count:3 forDisplay:0]);

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqualObjects(packed[1], @0, @"a rejected write must not publish anything");
}

/// An origin-only write that leaves the served buffer empty must keep the
/// snapshot at the empty-set version (1), not message-nil's 0. Android's
/// empty snapshot stays at version 1 the same way.
- (void)testAnOriginOnlyWriteThatLeavesServedEmptyKeepsVersionOne {
  [_store setOrigin:CGPointMake(0, 96) forDisplay:0];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqualObjects(packed[0], @1,
                        @"origin-only with no rectangles must not report version 0");
  XCTAssertEqualObjects(packed[1], @0);
}

/// The main origin must not move another surface's rectangle, and that
/// surface's own origin must.
- (void)testTheMainOriginDoesNotMoveAnotherSurfacesRectangle {
  const int32_t mainRects[] = {10, 20, 30, 40};
  const int32_t modalRects[] = {100, 200, 150, 250};
  [_store setCoordinates:mainRects count:4 forDisplay:0 surface:BGSRNSecureMainSurface];
  [_store setCoordinates:modalRects count:4 forDisplay:0 surface:42];
  [_store setOrigin:CGPointMake(0, 96) forDisplay:0 surface:BGSRNSecureMainSurface];
  [_store setOrigin:CGPointMake(0, 0) forDisplay:0 surface:42];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqualObjects(packed[1], @2);
  XCTAssertEqualObjects([packed subarrayWithRange:NSMakeRange(2, 8)],
                        (@[ @10, @116, @30, @136, @100, @200, @150, @250 ]));
}

- (void)testAnotherSurfacesOwnOriginMovesOnlyItsRectangle {
  const int32_t mainRects[] = {10, 20, 30, 40};
  const int32_t modalRects[] = {100, 200, 150, 250};
  [_store setCoordinates:mainRects count:4 forDisplay:0 surface:BGSRNSecureMainSurface];
  [_store setCoordinates:modalRects count:4 forDisplay:0 surface:42];
  [_store setOrigin:CGPointMake(0, 96) forDisplay:0 surface:BGSRNSecureMainSurface];
  [_store setOrigin:CGPointMake(7, 40) forDisplay:0 surface:42];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqualObjects(packed[1], @2);
  XCTAssertEqualObjects([packed subarrayWithRange:NSMakeRange(2, 8)],
                        (@[ @10, @116, @30, @136, @107, @240, @157, @290 ]));
}

/// A Modal's rectangles before its origin is recorded redact exactly the screen.
- (void)testASurfaceWithNoOriginYetServesTheScreenBounds {
  const int32_t modalRects[] = {100, 200, 150, 250, 1, 2, 3, 4};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  [_store setCoordinates:modalRects count:8 forDisplay:0 surface:42];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertEqualObjects(packed[1], @1);
  XCTAssertEqualObjects([packed subarrayWithRange:NSMakeRange(2, 4)], (@[ @0, @0, @402, @874 ]));
}

- (void)testAFractionalScreenSizeIsRoundedUp {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setDisplaySize:CGSizeMake(402.5, 873.2) forDisplay:0];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];

  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @0, @0, @403, @874 ]));
}

- (void)testBeforeTheScreenSizeIsKnownTheWholeDisplayIsTheFallbackSquare {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];

  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @0, @0, @(BGSRNSecureFallbackDisplaySize), @(BGSRNSecureFallbackDisplaySize) ]));
}

- (void)testRecordingTheScreenSizeMovesTheVersionOnlyWhenWhatIsServedChanges {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  NSNumber *sized = [self unpack:[_store snapshotForDisplay:0]][0];
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  [_store setDisplaySize:CGSizeZero forDisplay:0];

  XCTAssertNotEqualObjects(sized, before);
  XCTAssertEqualObjects([self unpack:[_store snapshotForDisplay:0]][0], sized);
}

- (void)testRecordingTheSurfacesOriginReplacesTheWholeDisplayRectangle {
  const int32_t modalRects[] = {100, 200, 150, 250};
  [_store setCoordinates:modalRects count:4 forDisplay:0 surface:42];
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store setOrigin:CGPointZero forDisplay:0 surface:42];

  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertNotEqualObjects(packed[0], before);
  XCTAssertEqualObjects([packed subarrayWithRange:NSMakeRange(2, 4)], (@[ @100, @200, @150, @250 ]));
}

/// The main surface fails closed too, until its first origin is recorded.
- (void)testTheMainSurfaceWithNoOriginYetServesTheScreenBounds {
  BGSRNSecureRectangles *bare = [[BGSRNSecureRectangles alloc] init];
  const int32_t rects[] = {10, 20, 30, 40};
  [bare setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  [bare setCoordinates:rects count:4 forDisplay:0];

  XCTAssertEqualObjects([[self unpack:[bare snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @0, @0, @402, @874 ]));

  [bare setOrigin:CGPointMake(0, 59) forDisplay:0];
  XCTAssertEqualObjects([[self unpack:[bare snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @10, @79, @30, @99 ]));
}

/// A fractional origin grows the rectangle by under a point, never shrinks it.
- (void)testAFractionalOriginRoundsEveryEdgeOutward {
  const int32_t rects[] = {10, 20, 30, 40};
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];
  [_store setOrigin:CGPointMake(0.5, 59.25) forDisplay:0 surface:42];

  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @10, @79, @31, @100 ]));
}

- (void)testANegativeFractionalOriginAlsoRoundsOutward {
  const int32_t rects[] = {10, 20, 30, 40};
  [_store setCoordinates:rects count:4 forDisplay:0];
  [_store setOrigin:CGPointMake(-0.5, -0.5) forDisplay:0];

  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @9, @19, @30, @40 ]));
}

- (void)testAnOriginSaturatesInsteadOfWrapping {
  const int32_t rects[] = {INT32_MAX - 1, INT32_MIN + 1, INT32_MAX - 1, INT32_MIN + 1};
  [_store setCoordinates:rects count:4 forDisplay:0];
  [_store setOrigin:CGPointMake(10, -10) forDisplay:0];

  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(2, 4)],
                        (@[ @(INT32_MAX), @((uint32_t)INT32_MIN), @(INT32_MAX), @((uint32_t)INT32_MIN) ]),
                        @"unpack reads each int32's bits as unsigned");
}

- (void)testRecordingTheSameOriginAgainHoldsTheVersion {
  const int32_t rects[] = {10, 20, 30, 40};
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];
  [_store setOrigin:CGPointMake(0, 59) forDisplay:0 surface:42];
  NSNumber *settled = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store setOrigin:CGPointMake(0, 59) forDisplay:0 surface:42];

  XCTAssertEqualObjects([self unpack:[_store snapshotForDisplay:0]][0], settled);
}

- (void)testListsTheSurfacesOtherThanTheMainOne {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:rects count:4 forDisplay:0];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:78];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];
  [_store setCoordinates:rects count:4 forDisplay:1 surface:99];

  XCTAssertEqualObjects([_store surfacesForDisplay:0], (@[ @42, @78 ]));
}

- (void)testDropsOnlyAnEmptyNonMainSurface {
  const int32_t rects[] = {1, 2, 3, 4};
  [_store setCoordinates:NULL count:0 forDisplay:0 surface:42];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:78];
  [_store setCoordinates:NULL count:0 forDisplay:0];
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store dropSurfaceIfEmpty:42];
  [_store dropSurfaceIfEmpty:78];
  [_store dropSurfaceIfEmpty:BGSRNSecureMainSurface];

  XCTAssertEqualObjects([_store surfacesForDisplay:0], (@[ @78 ]));
  XCTAssertEqualObjects([self unpack:[_store snapshotForDisplay:0]][0], before);
}

/// A new runtime drops the Modal surfaces the old one left; the main one
/// stays, emptied, with its origin.
- (void)testClaimingANewRuntimeDropsEveryModalSurfaceButKeepsTheMainOne {
  const int32_t mainRects[] = {10, 20, 30, 40};
  const int32_t modalRects[] = {100, 200, 150, 250};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  [_store setCoordinates:mainRects count:4 forDisplay:0];
  [_store setCoordinates:modalRects count:4 forDisplay:0 surface:42];
  [_store setCoordinates:modalRects count:4 forDisplay:1 surface:43];
  NSNumber *before = [self unpack:[_store snapshotForDisplay:0]][0];

  [_store claimRuntime];

  XCTAssertEqualObjects([_store surfacesForDisplay:0], @[]);
  XCTAssertEqualObjects([_store surfacesForDisplay:1], @[]);
  NSArray *packed = [self unpack:[_store snapshotForDisplay:0]];
  XCTAssertNotEqualObjects(packed[0], before);
  XCTAssertEqualObjects(packed[1], @0);
}

/// The main surface's origin survives the claim: the new runtime's first set
/// is placed, not failed closed.
- (void)testAClaimKeepsTheMainSurfacesOrigin {
  const int32_t oldRects[] = {10, 20, 30, 40};
  const int32_t newRects[] = {1, 2, 3, 4};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  [_store setOrigin:CGPointMake(5, 7) forDisplay:0];
  [_store setCoordinates:oldRects count:4 forDisplay:0];

  const NSInteger current = [_store claimRuntime];
  XCTAssertTrue([_store setCoordinates:newRects count:4 forDisplay:0 surface:BGSRNSecureMainSurface runtime:current]);

  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(1, 5)],
                        (@[ @1, @6, @9, @8, @11 ]));
}

/// The old runtime's main set must not outlive it: its clearing write is
/// stale, and a new tree that never publishes on the main surface would
/// otherwise keep masking where the old secure view was.
- (void)testAClaimWithAMainSetThenAStaleEmptyWriteAndNoNewPublishServesNothing {
  const int32_t rects[] = {10, 20, 30, 40};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  const NSInteger old = [_store claimRuntime];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:BGSRNSecureMainSurface runtime:old];
  XCTAssertEqualObjects([self unpack:[_store snapshotForDisplay:0]][1], @1);

  [_store claimRuntime];
  XCTAssertFalse([_store setCoordinates:NULL count:0 forDisplay:0 surface:BGSRNSecureMainSurface runtime:old]);

  XCTAssertEqualObjects([self unpack:[_store snapshotForDisplay:0]][1], @0);
}

- (void)testReleasingTheCurrentRuntimeDropsItsModalSurfaces {
  const int32_t rects[] = {1, 2, 3, 4};
  const NSInteger claim = [_store claimRuntime];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];

  [_store releaseRuntime:claim];

  XCTAssertEqualObjects([_store surfacesForDisplay:0], @[]);
}

/// A reload can start the new module before the old one is released.
- (void)testReleasingAnOldRuntimeLeavesTheNewRuntimesSurfaces {
  const int32_t rects[] = {1, 2, 3, 4};
  const NSInteger old = [_store claimRuntime];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:42];
  [_store claimRuntime];
  [_store setCoordinates:rects count:4 forDisplay:0 surface:58];

  [_store releaseRuntime:old];

  XCTAssertEqualObjects([_store surfacesForDisplay:0], @[ @58 ]);
}

/// The old module is not invalidated yet when the new one claims: its late
/// publish must not put back the Modal lane the claim dropped, which would
/// fail closed over the whole screen for the rest of the process.
- (void)testAStaleNonEmptyWriteDoesNotRecreateADroppedLane {
  const int32_t rects[] = {100, 200, 150, 250};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  const NSInteger old = [_store claimRuntime];
  XCTAssertTrue([_store setCoordinates:rects count:4 forDisplay:0 surface:42 runtime:old]);
  [_store claimRuntime];
  XCTAssertEqualObjects([_store surfacesForDisplay:0], @[]);
  NSData *before = [_store snapshotForDisplay:0];

  XCTAssertFalse([_store setCoordinates:rects count:4 forDisplay:0 surface:42 runtime:old]);

  XCTAssertEqualObjects([_store surfacesForDisplay:0], @[]);
  XCTAssertEqualObjects([_store snapshotForDisplay:0], before);
}

/// Fabric numbers React tags from 1 again after a reload, so the old
/// runtime's unmount clears the same key the new runtime's Modal now
/// publishes on. That empty write must not uncover the new Modal.
- (void)testAStaleEmptyWriteDoesNotClearTheNewRuntimesLaneOnTheSameTag {
  const int32_t oldRects[] = {1, 2, 3, 4};
  const int32_t newRects[] = {100, 200, 150, 250};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  const NSInteger old = [_store claimRuntime];
  [_store setCoordinates:oldRects count:4 forDisplay:0 surface:42 runtime:old];
  const NSInteger current = [_store claimRuntime];
  [_store setCoordinates:newRects count:4 forDisplay:0 surface:42 runtime:current];
  [_store setOrigin:CGPointMake(10, 20) forDisplay:0 surface:42];
  NSData *before = [_store snapshotForDisplay:0];
  XCTAssertEqualObjects([[self unpack:before] subarrayWithRange:NSMakeRange(1, 5)],
                        (@[ @1, @110, @220, @160, @270 ]));

  XCTAssertFalse([_store setCoordinates:NULL count:0 forDisplay:0 surface:42 runtime:old]);

  XCTAssertEqualObjects([_store snapshotForDisplay:0], before);
}

- (void)testTheCurrentRuntimesWritesStillApply {
  const int32_t rects[] = {100, 200, 150, 250};
  [_store setDisplaySize:CGSizeMake(402, 874) forDisplay:0];
  [_store claimRuntime];
  const NSInteger current = [_store claimRuntime];
  XCTAssertEqual([_store currentClaim], current);

  XCTAssertTrue([_store setCoordinates:rects count:4 forDisplay:0 surface:42 runtime:current]);
  [_store setOrigin:CGPointMake(10, 20) forDisplay:0 surface:42];
  XCTAssertEqualObjects([[self unpack:[_store snapshotForDisplay:0]] subarrayWithRange:NSMakeRange(1, 5)],
                        (@[ @1, @110, @220, @160, @270 ]));

  XCTAssertTrue([_store setCoordinates:NULL count:0 forDisplay:0 surface:42 runtime:current]);
  XCTAssertEqualObjects([self unpack:[_store snapshotForDisplay:0]][1], @0);
}

/// A malformed write from the current runtime is still rejected, not applied.
- (void)testTheCurrentRuntimesMalformedWriteIsStillRejected {
  const int32_t rects[] = {1, 2, 3};
  const NSInteger current = [_store claimRuntime];

  XCTAssertFalse([_store setCoordinates:rects count:3 forDisplay:0 surface:42 runtime:current]);
  XCTAssertEqualObjects([_store surfacesForDisplay:0], @[]);
}

/// The shared store outlives any one wrapper: the init provider registers one
/// before launch and setWrapperInfo swaps in another, and the regions the app
/// marked secret must survive that.
- (void)testSharedStoreIsOneInstance {
  XCTAssertTrue([BGSRNSecureRectangles shared] == [BGSRNSecureRectangles shared]);
}

@end
