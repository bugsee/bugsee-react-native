@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

#import "BGSRNFakeReport.h"

/// A deadline the test fires by hand; records cancellation.
@interface BGSRNManualTask : NSObject
@property (nonatomic, copy) dispatch_block_t block;
@property (nonatomic) int64_t delayMs;
@property (nonatomic) BOOL cancelled;
@end

@implementation BGSRNManualTask
@end

/// The one property everything here protects: the SDK's completion runs
/// exactly once for every dispatch, whichever of JS, the deadline, a detach or
/// a failure gets there first. Running it twice advances the SDK's chain
/// twice; never running it stalls the report until the SDK's own timeout.
///
/// Mirrors Android's `ReportHandlerBridgeTest` by name, except where iOS
/// differs on purpose: a recovered (off-main) report reaches JS here.
@interface BGSRNReportHandlerBridgeTests : XCTestCase
@end

@implementation BGSRNReportHandlerBridgeTests {
  NSMutableArray<BGSRNManualTask *> *_tasks;
  NSMutableArray<NSString *> *_lines;
  NSMutableArray<NSDictionary *> *_requests;
  BGSRNReportHandlerBridge *_bridge;
  BGSRNFakeReport *_report;
  NSObject *_sink;
  NSInteger _completions;
  BGSCallback _completion;
}

- (void)setUp {
  [super setUp];
  NSMutableArray<BGSRNManualTask *> *tasks = [NSMutableArray array];
  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  _tasks = tasks;
  _lines = lines;
  _requests = [NSMutableArray array];
  _bridge = [[BGSRNReportHandlerBridge alloc]
      initWithScheduler:^id(dispatch_block_t task, int64_t delayMs) {
        BGSRNManualTask *t = [BGSRNManualTask new];
        t.block = task;
        t.delayMs = delayMs;
        [tasks addObject:t];
        return t;
      }
      cancel:^(id token) {
        ((BGSRNManualTask *)token).cancelled = YES;
      }
      log:^(NSString *line) {
        [lines addObject:line];
      }];
  _report = [BGSRNFakeReport new];
  _sink = [NSObject new];
  _completions = 0;
  __weak __typeof(self) weakSelf = self;
  _completion = ^{
    __strong __typeof(weakSelf) strongSelf = weakSelf;
    strongSelf->_completions += 1;
  };
}

- (void)attachRecorder:(id)sink into:(NSMutableArray<NSDictionary *> *)requests {
  [_bridge attach:sink block:^(NSDictionary *request) {
    [requests addObject:request];
  }];
}

- (void)attachWithBothPhases {
  [self attachRecorder:_sink into:_requests];
  [_bridge setPhasesBefore:YES after:YES];
}

- (void)dispatchLive:(BGSRNReportPhase)phase terminating:(BOOL)terminating {
  [_bridge dispatchPhase:phase report:_report isTerminating:terminating onMainThread:YES completion:_completion];
}

- (void)fireDue {
  for (BGSRNManualTask *t in [_tasks copy]) {
    if (!t.cancelled) {
      t.block();
    }
  }
}

/// The real race: the deadline has already started when `cancel` arrives, so
/// cancelling does not stop it.
- (void)fireEvenIfCancelled {
  for (BGSRNManualTask *t in [_tasks copy]) {
    t.block();
  }
}

/// iOS never passes YES today, but the contract allows it: the process dies
/// when the callback returns, and nothing asynchronous survives it.
- (void)testTerminatingCompletesSynchronouslyAndNeverReachesJs {
  [self attachWithBothPhases];

  [self dispatchLive:BGSRNReportPhaseBefore terminating:YES];

  XCTAssertEqual(_completions, 1);
  XCTAssertEqual(_requests.count, 0u);
  XCTAssertEqual(_tasks.count, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN report handler - completed by=terminating phase=before report=report-1" ]));
}

/// Start-up, or after a reload tore the bridge down.
- (void)testNoSinkCompletesImmediately {
  [_bridge setPhasesBefore:YES after:YES];

  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];

  XCTAssertEqual(_completions, 1);
  XCTAssertEqual(_tasks.count, 0u);
  XCTAssertEqualObjects(_lines, (@[ @"BugseeRN report handler - completed by=no-handler phase=after report=report-1" ]));
}

/// JS registered only one phase; the other must not cost a round trip.
- (void)testUnregisteredPhaseCompletesImmediately {
  [self attachRecorder:_sink into:_requests];
  [_bridge setPhasesBefore:NO after:YES];

  [self dispatchLive:BGSRNReportPhaseBefore terminating:NO];

  XCTAssertEqual(_completions, 1);
  XCTAssertEqual(_requests.count, 0u);

  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  XCTAssertEqual(_requests.count, 1u);
  XCTAssertEqual(_completions, 1);
}

/// `onAfter` can be delivered more than once for one report.
- (void)testEachDeliveryGetsAFreshHandle {
  [self attachWithBothPhases];

  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];

  NSString *first = _requests[0][@"handleId"];
  NSString *second = _requests[1][@"handleId"];
  XCTAssertNotEqualObjects(first, second);
  XCTAssertTrue([first hasPrefix:@"rh-"]);
  XCTAssertEqual([_bridge reportFor:first], _report);
  XCTAssertEqual([_bridge reportFor:second], _report);

  XCTAssertTrue([_bridge complete:first]);
  XCTAssertNil([_bridge reportFor:first]);
  XCTAssertEqual([_bridge reportFor:second], _report);
  XCTAssertEqual(_completions, 1);
}

/// JS completes twice (the dispatcher's own guarantee is once, but a native
/// no-op is the contract), a detach sweeps outstanding handles, and the
/// deadline was already running when it was cancelled. One completion.
- (void)testCompleteRunsTheSdkCompletionExactlyOnce {
  [self attachWithBothPhases];
  [self dispatchLive:BGSRNReportPhaseBefore terminating:NO];
  NSString *handleId = _requests.lastObject[@"handleId"];

  XCTAssertTrue([_bridge complete:handleId]);
  XCTAssertFalse([_bridge complete:handleId]);
  [_bridge detach:_sink];
  [self fireEvenIfCancelled];

  XCTAssertEqual(_completions, 1);
}

- (void)testDeadlineCompletesAndKillsTheHandle {
  [self attachWithBothPhases];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  NSString *handleId = _requests.lastObject[@"handleId"];
  XCTAssertEqual(_tasks[0].delayMs, BGSRNLiveDeadlineMs);

  [self fireDue];

  XCTAssertEqual(_completions, 1);
  XCTAssertNil([_bridge reportFor:handleId]);
  XCTAssertFalse([_bridge complete:handleId]);
  XCTAssertEqual(_completions, 1);
  XCTAssertEqualObjects(_lines.lastObject,
                        ([NSString stringWithFormat:@"BugseeRN report handler %@ completed by=deadline", handleId]));
}

- (void)testCompletingBeforeTheDeadlineCancelsTheTimer {
  [self attachWithBothPhases];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];

  [_bridge complete:_requests.lastObject[@"handleId"]];

  XCTAssertTrue(_tasks[0].cancelled);
}

/// A reload: nothing in the new JS runtime knows the old handles, so they are
/// completed now rather than left for the deadline, and the phases the old
/// runtime asked for no longer describe anyone.
- (void)testDetachCompletesEverythingOutstanding {
  [self attachWithBothPhases];
  [self dispatchLive:BGSRNReportPhaseBefore terminating:NO];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  NSString *first = _requests[0][@"handleId"];

  [_bridge detach:_sink];

  XCTAssertEqual(_completions, 2);
  XCTAssertNil([_bridge reportFor:first]);
  XCTAssertTrue(_tasks[0].cancelled);
  XCTAssertTrue(_tasks[1].cancelled);
  XCTAssertEqualObjects(_lines.lastObject,
                        ([NSString stringWithFormat:@"BugseeRN report handler %@ completed by=detach",
                                                    _requests[1][@"handleId"]]));

  // Phases are cleared: a sink attached later gets nothing until its own
  // runtime registers.
  NSMutableArray<NSDictionary *> *next = [NSMutableArray array];
  NSObject *nextSink = [NSObject new];
  [self attachRecorder:nextSink into:next];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  XCTAssertEqual(next.count, 0u);
  XCTAssertEqual(_completions, 3);
}

/// A fast reload attaches the new module before the old one is invalidated.
/// The old detach must not silence the new bridge -- but the handles it was
/// given die with it.
- (void)testDetachingAStaleSinkLeavesTheCurrentOne {
  [self attachWithBothPhases];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  NSString *staleHandle = _requests.lastObject[@"handleId"];

  NSMutableArray<NSDictionary *> *current = [NSMutableArray array];
  NSObject *currentSink = [NSObject new];
  [self attachRecorder:currentSink into:current];
  [_bridge setPhasesBefore:YES after:YES];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];
  NSString *currentHandle = current.lastObject[@"handleId"];

  [_bridge detach:_sink];

  XCTAssertEqual(_completions, 1);
  XCTAssertNil([_bridge reportFor:staleHandle]);
  XCTAssertNotNil([_bridge reportFor:currentHandle]);

  [self dispatchLive:BGSRNReportPhaseBefore terminating:NO];
  XCTAssertEqual(current.count, 2u);
}

/// A new sink is a new JS runtime, which has registered nothing yet. Until it
/// does, a dispatch must not wait on a listener that does not exist.
- (void)testAttachingANewSinkClearsPhases {
  [self attachWithBothPhases];

  [self attachRecorder:[NSObject new] into:[NSMutableArray array]];
  [self dispatchLive:BGSRNReportPhaseAfter terminating:NO];

  XCTAssertEqual(_completions, 1);
}

/// A dead bridge throws from the emit, on the SDK's thread (main, on the live
/// path). JS will never answer, so the bridge answers for it now.
- (void)testAThrowingSinkStillCompletes {
  [_bridge attach:_sink block:^(NSDictionary *request) {
    [NSException raise:NSInternalInconsistencyException format:@"bridge is gone"];
  }];
  [_bridge setPhasesBefore:YES after:YES];

  [self dispatchLive:BGSRNReportPhaseBefore terminating:NO];

  XCTAssertEqual(_completions, 1);
  XCTAssertTrue(_tasks[0].cancelled);
}

- (void)testAThrowingSdkCompletionDoesNotEscape {
  [self attachWithBothPhases];
  BGSCallback throwing = ^{
    [NSException raise:NSInternalInconsistencyException format:@"sdk failure"];
  };
  [_bridge dispatchPhase:BGSRNReportPhaseBefore report:_report isTerminating:NO onMainThread:YES completion:throwing];

  XCTAssertTrue([_bridge complete:_requests.lastObject[@"handleId"]]);

  XCTAssertNoThrow([_bridge dispatchPhase:BGSRNReportPhaseBefore
                                   report:_report
                            isTerminating:YES
                             onMainThread:YES
                               completion:throwing]);
}

/// The request carries the report, and the live deadline, to JS.
- (void)testTheLiveRequestCarriesTheReportAndTheLiveDeadline {
  [self attachWithBothPhases];
  _report.fakeType = @"crash";

  [self dispatchLive:BGSRNReportPhaseBefore terminating:NO];

  NSDictionary *request = _requests.lastObject;
  XCTAssertEqualObjects(request[@"phase"], @"before");
  XCTAssertEqualObjects(request[@"reportId"], @"report-1");
  XCTAssertEqualObjects(request[@"type"], @"crash");
  XCTAssertEqualObjects(request[@"deadlineMs"], @25000.0);
  XCTAssertEqual(_tasks[0].delayMs, 25000);
  XCTAssertEqualObjects(_lines[0],
                        ([NSString stringWithFormat:@"BugseeRN report handler %@ phase=before deadline=25000",
                                                    request[@"handleId"]]));

  XCTAssertTrue([_bridge complete:request[@"handleId"]]);
  XCTAssertEqualObjects(_lines[1],
                        ([NSString stringWithFormat:@"BugseeRN report handler %@ completed by=js",
                                                    request[@"handleId"]]));
}

/// Unlike Android, a recovered report (off main) DOES reach JS on iOS: the SDK
/// re-persists it when a late completion arrives. It gets the short deadline.
- (void)testARecoveredReportReachesJsWithTheRecoveryDeadline {
  [self attachWithBothPhases];

  [_bridge dispatchPhase:BGSRNReportPhaseAfter report:_report isTerminating:NO onMainThread:NO completion:_completion];

  XCTAssertEqual(_requests.count, 1u);
  XCTAssertEqualObjects(_requests[0][@"deadlineMs"], @2500.0);
  XCTAssertEqual(_tasks[0].delayMs, 2500);
  XCTAssertEqual(_completions, 0);
}

- (void)testSharedIsOneInstance {
  XCTAssertNotNil(BGSRNReportHandlerBridge.shared);
  XCTAssertTrue(BGSRNReportHandlerBridge.shared == BGSRNReportHandlerBridge.shared);
}

@end
