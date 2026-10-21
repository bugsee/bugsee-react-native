@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

@interface BGSRNFakeSpan : NSObject <BGSRNRetainedSpan>
@property (nonatomic) BOOL finished;
@property (nonatomic) NSInteger finishCalls;
@property (nonatomic, strong) NSNumber *finishedWith;
@property (nonatomic, strong) NSMutableArray<BGSRNFakeSpan *> *order;
@property (nonatomic, strong) NSMutableArray<BGSRNFakeSpan *> *children;
@end

@implementation BGSRNFakeSpan

- (instancetype)init {
  self = [super init];
  if (self) {
    _children = [NSMutableArray array];
  }
  return self;
}

/// No self-guard against a second finish: a registry that finishes a span
/// twice shows in `finishCalls`.
- (void)bgsrnFinishWithStatus:(NSNumber *)status {
  _finishCalls += 1;
  [_order addObject:self];
  _finished = YES;
  _finishedWith = status;
  for (BGSRNFakeSpan *child in _children) {
    if (!child.finished) {
      child.order = _order;
      [child bgsrnFinishWithStatus:@(BGSSpanStatusCancelled)];
    }
  }
}

- (BOOL)bgsrnIsFinished {
  return _finished;
}

- (NSInteger)bgsrnStatus {
  return _finishedWith != nil ? _finishedWith.integerValue : BGSSpanStatusOK;
}

@end

@interface BGSRNStickySpan : NSObject <BGSRNRetainedSpan>
@property (nonatomic) BOOL finishCalled;
@end

@implementation BGSRNStickySpan
- (void)bgsrnFinishWithStatus:(NSNumber *)status {
  _finishCalled = YES;
}
- (BOOL)bgsrnIsFinished {
  return NO;
}
- (NSInteger)bgsrnStatus {
  return BGSSpanStatusUnknown;
}
@end

@interface BGSRNThrowingSpan : BGSRNStickySpan
@end

@implementation BGSRNThrowingSpan
- (void)bgsrnFinishWithStatus:(NSNumber *)status {
  @throw [NSException exceptionWithName:@"boom" reason:@"boom" userInfo:nil];
}
@end

static NSArray<NSString *> *BGSRNHandlesOf(NSArray<NSDictionary *> *released) {
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  for (NSDictionary *item in released) {
    [out addObject:item[@"handle"]];
  }
  return out;
}

@interface BGSRNSpanHandlesTests : XCTestCase
@end

@implementation BGSRNSpanHandlesTests

/// A reload must not leave transactions open in the SDK.
- (void)testCancelOpenAndReleaseAllCancelsOwnedOpenSpansParentFirstAndOnce {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  NSMutableArray<BGSRNFakeSpan *> *order = [NSMutableArray array];
  BGSRNFakeSpan *parent = [BGSRNFakeSpan new];
  BGSRNFakeSpan *child = [BGSRNFakeSpan new];
  BGSRNFakeSpan *done = [BGSRNFakeSpan new];
  parent.order = order;
  child.order = order;
  done.order = order;
  done.finished = YES;
  [parent.children addObject:child];
  [handles retainSpan:parent adapter:parent];
  [handles retainSpan:child adapter:child];
  [handles retainSpan:done adapter:done];
  [handles cancelOpenAndReleaseAll];
  XCTAssertEqual(parent.finishCalls, 1);
  XCTAssertEqualObjects(parent.finishedWith, @(BGSSpanStatusCancelled));
  XCTAssertEqual(child.finishCalls, 1);
  XCTAssertEqualObjects(child.finishedWith, @(BGSSpanStatusCancelled));
  XCTAssertEqual(done.finishCalls, 0, @"an already-finished span is skipped");
  XCTAssertEqualObjects(order, (@[parent, child]));
  XCTAssertEqual(handles.liveCount, 0u);
}

/// The active span belongs to the SDK or the app, not to this runtime.
- (void)testCancelOpenAndReleaseAllDropsAdoptedSpansWithoutCancellingThem {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNFakeSpan *adopted = [BGSRNFakeSpan new];
  BGSRNFakeSpan *owned = [BGSRNFakeSpan new];
  [handles retainSpan:adopted adapter:adopted owned:NO];
  [handles retainSpan:owned adapter:owned owned:YES];
  [handles cancelOpenAndReleaseAll];
  XCTAssertEqual(adopted.finishCalls, 0);
  XCTAssertFalse(adopted.finished);
  XCTAssertEqual(owned.finishCalls, 1);
  XCTAssertEqual(handles.liveCount, 0u);
}

- (void)testCancelOpenAndReleaseAllSurvivesASpanThatThrows {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNThrowingSpan *bad = [BGSRNThrowingSpan new];
  BGSRNFakeSpan *next = [BGSRNFakeSpan new];
  [handles retainSpan:bad adapter:bad];
  [handles retainSpan:next adapter:next];
  [handles cancelOpenAndReleaseAll];
  XCTAssertEqual(next.finishCalls, 1);
  XCTAssertEqual(handles.liveCount, 0u);
}

/// The pin: after finish the registry must not still hold the span.
- (void)testAFinishedSpanIsReleased {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNFakeSpan *span = [BGSRNFakeSpan new];
  NSString *handle = [handles retainSpan:span adapter:span];
  NSArray<NSString *> *released = BGSRNHandlesOf([handles finishHandle:handle status:nil]);
  XCTAssertEqualObjects(released, @[handle]);
  XCTAssertTrue(span.finished);
  XCTAssertNil(span.finishedWith);
  XCTAssertFalse([handles containsHandle:handle]);
  XCTAssertEqual(handles.liveCount, 0u);
}

- (void)testFinishingAParentReleasesAFinishedChild {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNFakeSpan *parent = [BGSRNFakeSpan new];
  BGSRNFakeSpan *child = [BGSRNFakeSpan new];
  [parent.children addObject:child];
  NSString *parentHandle = [handles retainSpan:parent adapter:parent];
  NSString *childHandle = [handles retainSpan:child adapter:child];
  NSArray<NSDictionary *> *releasedItems = [handles finishHandle:parentHandle status:nil];
  NSArray<NSString *> *released = BGSRNHandlesOf(releasedItems);
  XCTAssertEqual([releasedItems[1][@"status"] integerValue], (NSInteger)BGSSpanStatusCancelled);
  XCTAssertTrue([released containsObject:parentHandle]);
  XCTAssertTrue([released containsObject:childHandle]);
  XCTAssertTrue(child.finished);
  XCTAssertEqual(child.finishedWith.integerValue, (NSInteger)BGSSpanStatusCancelled);
  XCTAssertFalse([handles containsHandle:childHandle]);
  XCTAssertEqual(handles.liveCount, 0u);
}

- (void)testAnUnfinishedSpanStaysRetained {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNFakeSpan *finished = [BGSRNFakeSpan new];
  BGSRNFakeSpan *live = [BGSRNFakeSpan new];
  NSString *finishedHandle = [handles retainSpan:finished adapter:finished];
  NSString *liveHandle = [handles retainSpan:live adapter:live];
  [handles finishHandle:finishedHandle status:@(BGSSpanStatusError)];
  XCTAssertFalse([handles containsHandle:finishedHandle]);
  XCTAssertTrue([handles containsHandle:liveHandle]);
  XCTAssertEqual(handles.liveCount, 1u);
  XCTAssertEqual(finished.finishedWith.integerValue, (NSInteger)BGSSpanStatusError);
}

- (void)testTheSameSpanIsOneHandle {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNFakeSpan *span = [BGSRNFakeSpan new];
  NSString *first = [handles retainSpan:span adapter:span];
  NSString *second = [handles retainSpan:span adapter:[BGSRNFakeSpan new]];
  XCTAssertEqualObjects(first, second);
  XCTAssertEqual(handles.liveCount, 1u);
}

/// `finish` runs, and `isFinished` stays false. A no-op span can do that.
- (void)testASpanThatStaysUnfinishedIsStillReleased {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNStickySpan *span = [BGSRNStickySpan new];
  NSString *handle = [handles retainSpan:span adapter:span];
  NSArray<NSString *> *released = BGSRNHandlesOf([handles finishHandle:handle status:nil]);
  XCTAssertEqualObjects(released, @[handle]);
  XCTAssertTrue(span.finishCalled);
  XCTAssertFalse(span.bgsrnIsFinished);
  XCTAssertFalse([handles containsHandle:handle]);
  XCTAssertEqual(handles.liveCount, 0u);
}

- (void)testANilSpanIsNotRetained {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  XCTAssertEqualObjects([handles retainSpan:nil adapter:[BGSRNFakeSpan new]], @"");
  XCTAssertEqual(handles.liveCount, 0u);
}

/// The object `invalidate` returns. A later retain must not store anything.
- (void)testAClosedRegistryAdoptsNothing {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles closedRegistry];
  BGSRNFakeSpan *span = [BGSRNFakeSpan new];
  XCTAssertEqualObjects([handles retainSpan:span adapter:span], @"");
  XCTAssertEqual(handles.liveCount, 0u);
  XCTAssertEqualObjects([handles finishHandle:@"sp-1" status:nil], @[]);
}

- (void)testAnUnknownHandleReleasesNothing {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  XCTAssertEqualObjects([handles finishHandle:@"sp-nope" status:nil], @[]);
  XCTAssertEqual(handles.liveCount, 0u);
}

/// The wire integer is the SDK enum, not a second numbering.
- (void)testSpanStatusValuesMatchTheWire {
  XCTAssertEqual((NSInteger)BGSSpanStatusOK, 0);
  XCTAssertEqual((NSInteger)BGSSpanStatusError, 1);
  XCTAssertEqual((NSInteger)BGSSpanStatusTimeout, 2);
  XCTAssertEqual((NSInteger)BGSSpanStatusCancelled, 3);
  XCTAssertEqual((NSInteger)BGSSpanStatusDeadlineExceeded, 4);
  XCTAssertEqual((NSInteger)BGSSpanStatusUnknown, 5);
}

@end
