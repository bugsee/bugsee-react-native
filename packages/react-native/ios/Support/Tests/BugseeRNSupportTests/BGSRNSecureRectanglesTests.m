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

/// The shared store outlives any one wrapper: the init provider registers one
/// before launch and setWrapperInfo swaps in another, and the regions the app
/// marked secret must survive that.
- (void)testSharedStoreIsOneInstance {
  XCTAssertTrue([BGSRNSecureRectangles shared] == [BGSRNSecureRectangles shared]);
}

@end
