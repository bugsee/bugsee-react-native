@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

@interface BGSRNFakeSpan : NSObject <BGSRNRetainedSpan>
@property (nonatomic) BOOL finished;
@property (nonatomic, strong) NSNumber *finishedWith;
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

- (void)bgsrnFinishWithStatus:(NSNumber *)status {
  if (_finished) {
    return;
  }
  _finished = YES;
  _finishedWith = status;
  for (BGSRNFakeSpan *child in _children) {
    if (!child.finished) {
      [child bgsrnFinishWithStatus:@(BGSSpanStatusCancelled)];
    }
  }
}

- (BOOL)bgsrnIsFinished {
  return _finished;
}

@end

@interface BGSRNSpanHandlesTests : XCTestCase
@end

@implementation BGSRNSpanHandlesTests

/// The pin: after finish the registry must not still hold the span.
- (void)testAFinishedSpanIsReleased {
  BGSRNSpanHandles *handles = [BGSRNSpanHandles new];
  BGSRNFakeSpan *span = [BGSRNFakeSpan new];
  NSString *handle = [handles retainSpan:span adapter:span];
  NSArray<NSString *> *released = [handles finishHandle:handle status:nil];
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
  NSArray<NSString *> *released = [handles finishHandle:parentHandle status:nil];
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
