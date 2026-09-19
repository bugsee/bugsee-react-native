@import XCTest;
@import BugseeRNSupport;

/// The wrapper is registered before React Native exists, so lifecycle events
/// genuinely arrive with no bridge to deliver them to. That is the normal case
/// during start-up, not an error, and it is why the sink is separate from the
/// wrapper.
@interface BGSRNEventBusTests : XCTestCase
@end

@implementation BGSRNEventBusTests {
  BGSRNEventBus *_bus;
  NSMutableArray<NSString *> *_events;
}

- (void)setUp {
  [super setUp];
  _bus = [[BGSRNEventBus alloc] init];
  _events = [NSMutableArray array];
}

- (void)attachRecorder:(id)owner {
  // Captured directly rather than through the test case: dereferencing a weak
  // pointer is an ARC error (the value can be nilled between load and use), and
  // the array outlives the block regardless.
  NSMutableArray<NSString *> *events = _events;
  [_bus attach:owner block:^(NSString *name, NSString *reportId) {
    [events addObject:[NSString stringWithFormat:@"%@/%@", name, reportId ?: @"nil"]];
  }];
}

- (void)testSwallowsEventsWhenNoBridgeIsAttached {
  [_bus emitLifecycle:@"com.bugsee.lifecycle.Launching" reportId:nil];
  XCTAssertEqual(_events.count, 0u);
}

- (void)testDeliversToTheAttachedSink {
  NSObject *owner = [NSObject new];
  [self attachRecorder:owner];

  [_bus emitLifecycle:@"com.bugsee.lifecycle.Launched" reportId:nil];

  XCTAssertEqualObjects(_events.firstObject, @"Launched/nil");
}

/// The prefix is stripped here so the wire payload matches what the JS type
/// says. Both SDKs dispatch the prefixed form.
- (void)testStripsTheLifecyclePrefix {
  NSObject *owner = [NSObject new];
  [self attachRecorder:owner];

  [_bus emitLifecycle:@"com.bugsee.lifecycle.RelaunchedAfterCrash" reportId:nil];

  XCTAssertEqualObjects(_events.firstObject, @"RelaunchedAfterCrash/nil");
}

/// A newer SDK adding an event must not have it silently swallowed by an older
/// wrapper — that is the failure mode that hides a whole feature.
- (void)testForwardsAnUnknownNameUnchanged {
  NSObject *owner = [NSObject new];
  [self attachRecorder:owner];

  [_bus emitLifecycle:@"com.bugsee.lifecycle.SomethingNewIn8x" reportId:nil];
  [_bus emitLifecycle:@"TotallyUnexpected" reportId:nil];

  XCTAssertEqualObjects(_events[0], @"SomethingNewIn8x/nil");
  XCTAssertEqualObjects(_events[1], @"TotallyUnexpected/nil");
}

- (void)testPassesTheReportIdWhenTheEventCarriesOne {
  NSObject *owner = [NSObject new];
  [self attachRecorder:owner];

  [_bus emitLifecycle:@"com.bugsee.lifecycle.AfterReportUploaded" reportId:@"abc-123"];

  XCTAssertEqualObjects(_events.firstObject, @"AfterReportUploaded/abc-123");
}

- (void)testStopsDeliveringAfterDetach {
  NSObject *owner = [NSObject new];
  [self attachRecorder:owner];
  [_bus detach:owner];

  [_bus emitLifecycle:@"com.bugsee.lifecycle.Launched" reportId:nil];

  XCTAssertEqual(_events.count, 0u);
}

/// A fast reload can attach the new module before the old one is torn down;
/// the old one's detach must not silence the new one.
- (void)testDetachingAStaleSinkLeavesTheCurrentOneAttached {
  NSObject *stale = [NSObject new];
  NSObject *current = [NSObject new];
  [self attachRecorder:stale];
  [self attachRecorder:current];

  [_bus detach:stale];
  [_bus emitLifecycle:@"com.bugsee.lifecycle.Launched" reportId:nil];

  XCTAssertEqual(_events.count, 1u);
}

/// The bridge owns the module; holding it here would keep a torn-down instance
/// alive for the life of the process.
- (void)testDoesNotDeliverOnceTheSinkIsDeallocated {
  @autoreleasepool {
    NSObject *owner = [NSObject new];
    [self attachRecorder:owner];
  }

  [_bus emitLifecycle:@"com.bugsee.lifecycle.Launched" reportId:nil];

  XCTAssertEqual(_events.count, 0u);
}

- (void)testSharedIsOneInstance {
  XCTAssertTrue(BGSRNEventBus.shared == BGSRNEventBus.shared);
}

@end
