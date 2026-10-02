#import "BugseeModule.h"
#import "BGSRNConsoleCapture.h"

// Header imports, not `@import`. This file is ObjC++, and neither delivery path
// turns on C++ modules — CocoaPods sets CLANG_ENABLE_MODULES for ObjC only, and
// the SPM target does not pass -fcxx-modules either. A module import here fails
// with "use of '@import' when C++ modules are disabled", and then with a
// cascade of undeclared identifiers that hides the real cause.
#import <Bugsee/Bugsee.h>
#import <UIKit/UIKit.h>

// CocoaPods compiles BugseeRNSupport's sources straight into this pod, so its
// headers arrive flat; under SPM it is a separate target and they arrive under
// the module's own directory.
#if __has_include(<BugseeRNSupport/BGSRNTokens.h>)
#import <BugseeRNSupport/BGSRNMainThread.h>
#import <BugseeRNSupport/BGSRNWrapper.h>
#import <BugseeRNSupport/BGSRNWrapperChannelHolder.h>
#import <BugseeRNSupport/BGSRNStatusMapper.h>
#import <BugseeRNSupport/BGSRNSecureRectangles.h>
#import <BugseeRNSupport/BGSRNEventBus.h>
#import <BugseeRNSupport/BGSRNTokens.h>
#import <BugseeRNSupport/BGSRNReportHandlerBridge.h>
#import <BugseeRNSupport/BGSRNReportOps.h>
#import <BugseeRNSupport/BGSRNGuardedEmit.h>
#import <BugseeRNSupport/BGSRNValues.h>
#import <BugseeRNSupport/BGSRNJSON.h>
#import <BugseeRNSupport/BGSRNNetworkFilter.h>
#import <BugseeRNSupport/BGSRNNetworkEvents.h>
#import <BugseeRNSupport/BGSRNAttributes.h>
#import <BugseeRNSupport/BGSRNDataRequestBridge.h>
#import <BugseeRNSupport/BGSRNReactWindow.h>
#import <BugseeRNSupport/BGSRNExceptions.h>
#import <BugseeRNSupport/BGSRNSettleOnce.h>
#import <BugseeRNSupport/BGSRNReportArgs.h>
#import <BugseeRNSupport/BGSRNCreatedReports.h>
#import <BugseeRNSupport/BGSRNCreatedReportOps.h>
#else
#import "BGSRNMainThread.h"
#import "BGSRNWrapper.h"
#import "BGSRNWrapperChannelHolder.h"
#import "BGSRNStatusMapper.h"
#import "BGSRNSecureRectangles.h"
#import "BGSRNEventBus.h"
#import "BGSRNTokens.h"
#import "BGSRNReportHandlerBridge.h"
#import "BGSRNReportOps.h"
#import "BGSRNGuardedEmit.h"
#import "BGSRNValues.h"
#import "BGSRNJSON.h"
#import "BGSRNNetworkFilter.h"
#import "BGSRNNetworkEvents.h"
#import "BGSRNAttributes.h"
#import "BGSRNDataRequestBridge.h"
#import "BGSRNReactWindow.h"
#import "BGSRNExceptions.h"
#import "BGSRNSettleOnce.h"
#import "BGSRNReportArgs.h"
#import "BGSRNCreatedReports.h"
#import "BGSRNCreatedReportOps.h"
#endif

/// The conformance lives here rather than in the Support package so that the
/// package stays buildable and testable without the SDK's headers. BGSRNWrapper
/// already declares every property the protocol requires; this states that it
/// satisfies the contract.
@interface BGSRNWrapper (BugseeConformance) <BugseeWrapper>
@end

@implementation BGSRNWrapper (BugseeConformance)

/// Store the channel and return -- the SDK's contract for this callback,
/// verbatim. Nothing else belongs here: flushing anything buffered, taking a
/// lock, or calling back into the SDK from inside this callback are all ways
/// to discover one of the hazards `BGSWrapperChannel` documents.
- (void)onWrapperChannelAvailable:(id<BGSWrapperChannel>)channel {
  BGSRNWrapperChannelHolder.shared.channel = channel;
}

/// Through the bus rather than straight to the module: this wrapper is
/// registered before React Native has a JS runtime and is replaced once it
/// does, while the bridge appears late and can be torn down by a reload. The
/// two lifetimes do not line up, so neither side holds the other.
///
/// `data` is typed `id` because most events carry nothing; the ones that carry
/// something carry the report id as a string. Anything else is ignored rather
/// than stringified — a JS caller reading `reportId` should get the id or
/// nothing, never a description of some future payload shape.
- (void)onLifecycleEvent:(NSString *)eventType data:(id)data {
  NSString *reportId = [data isKindOfClass:NSString.class] ? (NSString *)data : nil;
  [BGSRNEventBus.shared emitLifecycle:eventType reportId:reportId];
}

/// The packed buffer the SDK expects: `[version, count, l,t,r,b, ...]` as
/// little-endian int32.
///
/// Read from the process-wide store rather than from this instance. The SDK
/// pulls 2-3 times a second on the MAIN thread, and the wrapper it pulls
/// through is replaced when `setWrapperInfo` runs — regions the app marked
/// secret must survive that swap. See `BGSRNSecureRectangles` for the version
/// contract, which is what makes the SDK notice a change at all.
- (NSData *)secureRectanglesForDisplay:(NSInteger)display {
  return [BGSRNSecureRectangles.shared snapshotForDisplay:display];
}

/// Through the data request bridge, for the same reason lifecycle events go
/// through the bus: this wrapper outlives every JS runtime.
///
/// The SDK asks on MAIN and does not wait there (SDK 0d9c9d0a3,
/// `BGSCaptureDataProviderViewHierarchy.m`): the callback is asynchronous and
/// accepted on any thread. The bridge answers exactly once -- synchronously
/// with nil when JS cannot answer, otherwise with JS's reply (on the module's
/// method queue) or nil at its deadline (on its own queue). Nothing here may
/// hop to or wait on main.
- (void)requestDataWithType:(NSString *)dataType
                   callback:(id<BGSDataRequestResultCallback>)callback {
  [BGSRNDataRequestBridge.shared requestType:dataType
                                       reply:^(NSString *d) {
                                         if ([callback respondsToSelector:@selector(onResult:)]) {
                                           [callback onResult:d];
                                         }
                                       }];
}

/// Through the report handler bridge, for the same reason lifecycle events go
/// through the bus: this wrapper outlives every JS runtime.
///
/// The thread is the only thing that tells the two paths apart. Live reports
/// arrive on MAIN, dispatched there with `dispatch_async`; recovered ones
/// arrive off main (see BGSRNReportDeadlines.h). Both reach JS, with different
/// deadlines. Nothing on this path may hop to main -- not because the SDK is
/// blocked on main waiting for us (it isn't: the completion is a
/// thread-agnostic run-once that hops to the SDK's own private queue, and main
/// is never held for it), but because there is no need to, and an op that did
/// would queue behind whatever UI work is already on main, eating into the
/// handle's deadline for nothing.
- (void)onBeforeReportCreated:(id<BGSReportContract>)report
                isTerminating:(BOOL)isTerminating
                   completion:(BGSCallback)completion {
  [BGSRNReportHandlerBridge.shared dispatchPhase:BGSRNReportPhaseBefore
                                          report:report
                                   isTerminating:isTerminating
                                    onMainThread:NSThread.isMainThread
                                      completion:completion];
}

- (void)onAfterReportCreated:(id<BGSReportContract>)report
               isTerminating:(BOOL)isTerminating
                  completion:(BGSCallback)completion {
  [BGSRNReportHandlerBridge.shared dispatchPhase:BGSRNReportPhaseAfter
                                          report:report
                                   isTerminating:isTerminating
                                    onMainThread:NSThread.isMainThread
                                      completion:completion];
}

@end

/// The one route to `+[Bugsee setWrapper:]` in this module, so a future call
/// site cannot bypass either half of this: the main-thread hop
/// `setWrapperInfo` already needed, and clearing the held wrapper channel
/// after a `nil` registration. `onWrapperChannelAvailable:` delivers a fresh
/// channel for a non-nil registration, so clearing only happens for `nil` --
/// clearing on every call would wipe a channel the instant it arrived.
///
/// Registrations must never overlap (the wrapper-channel contract). Main is
/// the lock: every call goes through a main-thread hop, so another call site
/// needs no lock of its own as long as it comes through here.
///
/// `onlyIfAbsent` is the module-init registration. A reload constructs a new
/// module while the previous runtime's full identity is still what the SDK
/// should report, and replacing it with the thin pre-JS wrapper would drop
/// that identity until JS called `setWrapperInfo` again. The flag is read
/// and written on main, beside `setWrapper:`.
///
/// Init uses `BGSRNRunOnMainSync`: `BGSRNRunOnMain` is async off main, so
/// `-init` could return with `+[Bugsee setWrapper:]` only queued. A later
/// `startBlackout` delivered on main would then run inline before that
/// registration and the SDK would drop `BlackoutStarted`. Ordinary
/// `setWrapperInfo` stays on the async hop.
static BOOL BGSRNWrapperIsRegistered = NO;

static void BGSRNSetWrapper(id<BugseeWrapper> _Nullable wrapper, BOOL onlyIfAbsent) {
  void (^body)(void) = ^{
    if (onlyIfAbsent && BGSRNWrapperIsRegistered) {
      return;
    }
    [Bugsee setWrapper:wrapper];
    if (wrapper == nil) {
      BGSRNWrapperChannelHolder.shared.channel = nil;
      BGSRNWrapperIsRegistered = NO;
    } else {
      BGSRNWrapperIsRegistered = YES;
    }
  };
  if (onlyIfAbsent) {
    BGSRNRunOnMainSync(body);
  } else {
    BGSRNRunOnMain(body);
  }
}

/// The `vh` origin: the `frame.origin` (points) of the window hosting the
/// React root, among the windows the SDK's own view-hierarchy walk visits --
/// the offset the SDK adds to every native node, so the two trees share one
/// space by construction (see `BGSRNReactWindow.h`). nil without one, or off
/// main: the SDK asks on main, and UIKit must not be read anywhere else.
///
/// The root is recognised by class name, not by import: `RCTSurfaceHostingView`
/// is the new architecture's root (the template's `RCTRootView` is its
/// `RCTSurfaceHostingProxyRootView` subclass); the legacy `RCTRootView` class
/// is matched too for interop hosts.
static NSValue *_Nullable BGSRNReactOrigin(void) {
  if (!NSThread.isMainThread) {
    return nil;
  }
  static Class surfaceHostingView;
  static Class legacyRootView;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    surfaceHostingView = NSClassFromString(@"RCTSurfaceHostingView");
    legacyRootView = NSClassFromString(@"RCTRootView");
  });
  UIWindow *keyWindow = BGSRNSdkKeyWindow();
  return BGSRNReactRootOrigin(keyWindow, BGSRNSdkWalkedWindows(keyWindow), ^BOOL(UIView *view) {
    return (surfaceHostingView != Nil && [view isKindOfClass:surfaceHostingView]) ||
           (legacyRootView != Nil && [view isKindOfClass:legacyRootView]);
  });
}

static NSString *const kHandleDeadCode = @"E_REPORT_HANDLE_DEAD";
static NSString *const kCreateBusyCode = @"E_REPORT_CREATE_BUSY";

static void BGSRNRejectHandleDead(RCTPromiseRejectBlock reject) {
  reject(kHandleDeadCode,
         @"This BugseeReport handle is no longer valid: its handler has "
         @"already settled, or its deadline has passed.",
         nil);
}

static void BGSRNRejectCreatedHandleDead(RCTPromiseRejectBlock reject) {
  reject(kHandleDeadCode, @"This created report handle is no longer valid.", nil);
}

/// No code of our own (React Native fills in `EUNSPECIFIED`, as Android's
/// `promise.reject(e)` does): an unexpected fault is not one of the three the
/// JS contract names, and inventing a fourth would make it matchable.
static void BGSRNRejectException(RCTPromiseRejectBlock reject, NSException *exception) {
  reject(nil, exception.reason ?: exception.name, nil);
}

/// The SDK returns nil both for a declined attachment and for a report that
/// is no longer live. The handle tells the two apart: if it died while the
/// call ran, that is the truer answer.
static void BGSRNSettleAttachment(NSString *handleId,
                                  BOOL added,
                                  NSError *error,
                                  RCTPromiseResolveBlock resolve,
                                  RCTPromiseRejectBlock reject) {
  if (added) {
    resolve(nil);
    return;
  }
  NSString *code = BGSRNReportErrorWireCode(error);
  if ([code isEqualToString:@"E_REPORT_ATTACHMENT_REJECTED"] &&
      [BGSRNReportHandlerBridge.shared reportFor:handleId] == nil) {
    BGSRNRejectHandleDead(reject);
    return;
  }
  reject(code, error.localizedDescription, nil);
}

static NSString *const kAttributeRejectedCode = @"E_ATTRIBUTE_REJECTED";

/// Sets `value` for `name` through `BGSRNAttributes`, which verifies with a
/// read-back rather than trusting the SDK's own return: `+setAttribute:
/// withValue:` returns `YES` even when it silently drops a value over its
/// archived-size limit (design doc, Phase 5 verified facts). The one path
/// `setAttributeString/-Number/-Boolean` share; on main, like every other SDK
/// entry point.
///
/// The rejection message names the attribute only -- never `value`, which may
/// be sensitive.
static void BGSRNSetAttribute(NSString *name,
                              id value,
                              RCTPromiseResolveBlock resolve,
                              RCTPromiseRejectBlock reject) {
  BGSRNRunOnMain(^{
    const BOOL kept = [BGSRNAttributes setValue:value
                                          forKey:name
                                          setter:^BOOL(NSString *key, id v) {
                                            return [Bugsee setAttribute:key withValue:v];
                                          }
                                          getter:^id(NSString *key) {
                                            return [Bugsee getAttribute:key];
                                          }];
    if (kept) {
      resolve(nil);
    } else {
      reject(kAttributeRejectedCode,
             [NSString stringWithFormat:@"attribute \"%@\" was not kept by the SDK", name],
             nil);
    }
  });
}


/// One in-flight network-filter request. The decision block is copied: the
/// SDK's block argument is not guaranteed to outlive the filter call, and the
/// reply comes back later, from JS. iOS's decision block is once-only and the
/// provider does not recycle the event, so a late reply still records. There
/// is no timer here: one that called `decision(nil)` would drop an event the
/// SDK is still willing to keep.
@interface BGSRNNetworkFilterPending : NSObject
@property (nonatomic, strong) BugseeNetworkEvent *event;
@property (nonatomic, copy) BugseeNetworkFilterDecisionBlock decision;
@property (nonatomic, weak) BugseeModule *owner;
@end
@implementation BGSRNNetworkFilterPending
@end

static __weak BugseeModule *BGSRNNetworkFilterModule = nil;
static BOOL BGSRNNetworkFilterInstalled = NO;
static NSMutableDictionary<NSString *, BGSRNNetworkFilterPending *> *BGSRNNetworkFilterPendingTable;
static int64_t BGSRNNetworkFilterNextId = 0;

static id BGSRNNetworkFilterLock(void) {
  static id lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [NSObject new];
    BGSRNNetworkFilterPendingTable = [NSMutableDictionary dictionary];
  });
  return lock;
}

/// Answers nil for every request `module` still holds, which drops the event.
/// Called outside the lock: the SDK's decision block must not re-enter it.
static void BGSRNDropNetworkFiltersOwnedBy(BugseeModule *module) {
  NSMutableArray<BugseeNetworkFilterDecisionBlock> *decisions = [NSMutableArray array];
  @synchronized (BGSRNNetworkFilterLock()) {
    for (NSString *key in BGSRNNetworkFilterPendingTable.allKeys) {
      BGSRNNetworkFilterPending *item = BGSRNNetworkFilterPendingTable[key];
      if (item.owner == module) {
        [BGSRNNetworkFilterPendingTable removeObjectForKey:key];
        if (item.decision != nil) {
          [decisions addObject:item.decision];
        }
      }
    }
  }
  for (BugseeNetworkFilterDecisionBlock decision in decisions) {
    decision(nil);
  }
}


@interface BGSRNLogFilterPending : NSObject
@property (nonatomic, strong) BugseeLogEvent *event;
@property (nonatomic, copy) BugseeLogFilterDecisionBlock decision;
@property (nonatomic, weak) BugseeModule *owner;
@end
@implementation BGSRNLogFilterPending
@end

static __weak BugseeModule *BGSRNLogFilterModule = nil;
static BOOL BGSRNLogFilterInstalled = NO;
static NSMutableDictionary<NSString *, BGSRNLogFilterPending *> *BGSRNLogFilterPendingTable;
static int64_t BGSRNLogFilterNextId = 0;

static id BGSRNLogFilterLock(void) {
  static id lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [NSObject new];
    BGSRNLogFilterPendingTable = [NSMutableDictionary dictionary];
  });
  return lock;
}

/// Answers `nil` for every request `module` still holds, which drops the line.
/// Called outside the lock: the SDK's decision block must not re-enter it.
static void BGSRNDropLogFiltersOwnedBy(BugseeModule *module) {
  NSMutableArray<BugseeLogFilterDecisionBlock> *decisions = [NSMutableArray array];
  @synchronized (BGSRNLogFilterLock()) {
    for (NSString *key in BGSRNLogFilterPendingTable.allKeys) {
      BGSRNLogFilterPending *item = BGSRNLogFilterPendingTable[key];
      if (item.owner == module) {
        [BGSRNLogFilterPendingTable removeObjectForKey:key];
        if (item.decision != nil) {
          [decisions addObject:item.decision];
        }
      }
    }
  }
  for (BugseeLogFilterDecisionBlock decision in decisions) {
    decision(nil);
  }
}


@implementation BugseeModule

RCT_EXPORT_MODULE(Bugsee)

/// Design §6.1: this wrapper registers at module init, the iOS counterpart of
/// Android's ContentProvider. Early enough that a `startBlackout()` made
/// before `launch()` has a wrapper to deliver `BlackoutStarted` to. Not
/// `attachToBridges` — that waits until `getTurboModule:` because the codegen
/// emitter is unset before then, and this call does not emit.
- (instancetype)init {
  if ((self = [super init])) {
    BGSRNSetWrapper((id<BugseeWrapper>)[BGSRNWrapper wrapperWithoutJsRuntime], YES);
    BGSRNInstallConsoleCapture();
  }
  return self;
}

/// Attaches this module to the lifecycle bus and the report handler bridge.
///
/// Called from `getTurboModule:`, right after the JSI object is built -- not
/// from `init`, and not on first subscribe. Not on first subscribe: the SDK
/// may emit before JS has subscribed, and a listener that only existed once JS
/// asked for it would miss the launch transitions a caller most wants. Not
/// from `init`: the codegen `emitOn*` methods call a `std::function` that the
/// generated `NativeBugseeSpecJSI` constructor sets, so attaching earlier let
/// the SDK's threads call it unset, and read it while the JS thread was still
/// assigning it. Attaching after it is set, under the bus's and bridge's own
/// locks, orders that write before any read.
- (void)attachToBridges {
  __weak __typeof(self) weakSelf = self;
  [BGSRNEventBus.shared attach:self block:^BOOL(NSString *name, NSString *reportId) {
    __strong __typeof(weakSelf) strongSelf = weakSelf;
    if (strongSelf == nil) {
      return NO;
    }
    // `reportId` omitted rather than NSNull when absent: the JS type marks it
    // optional, and a null would force every caller to distinguish "absent"
    // from "explicitly nothing".
    NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithObject:name forKey:@"name"];
    if (reportId != nil) {
      payload[@"reportId"] = reportId;
    }
    // Guarded like the report path below: a lifecycle event can arrive
    // after this module is gone (mid-reload), and an unset std::function
    // throws a C++ exception. BGSRNGuardedEmit catches it here, in
    // Objective-C++, and returns NO; the bus logs and drops the event --
    // there is no subscriber to queue it for.
    return BGSRNGuardedEmit(^{
      [strongSelf emitOnLifecycleEvent:payload];
    }, @"onLifecycleEvent");
  }];
  // The same lifetime rule for report handlers. The request is emitted
  // as-is: the bridge already built the wire payload.
  [BGSRNReportHandlerBridge.shared attach:self block:^BOOL(NSDictionary *request) {
    __strong __typeof(weakSelf) strongSelf = weakSelf;
    if (strongSelf == nil) {
      // NO makes the bridge complete the handle now, rather than leave the
      // report waiting out a deadline no JS will ever meet.
      return NO;
    }
    // The codegen emitter is a std::function, and an unset one throws a C++
    // exception. BGSRNGuardedEmit catches it here, in Objective-C++, and
    // returns NO, so the bridge completes the handle -- nothing unwinds
    // through the bridge's non-exception-safe ARC frames.
    return BGSRNGuardedEmit(^{
      [strongSelf emitOnReportHandlerRequest:request];
    }, @"onReportHandlerRequest");
  }];
  // And for the SDK's `vh` data request: the same guarded emit, so NO makes
  // the bridge answer the SDK nil at once (`by=sink-threw`).
  [BGSRNDataRequestBridge.shared attach:self
      block:^BOOL(NSDictionary *request) {
        __strong __typeof(weakSelf) strongSelf = weakSelf;
        if (strongSelf == nil) {
          return NO;
        }
        return BGSRNGuardedEmit(^{
          [strongSelf emitOnDataRequest:request];
        }, @"onDataRequest");
      }
      origin:^NSValue *_Nullable {
        return BGSRNReactOrigin();
      }];
  // After the emitter exists. A network filter installed earlier reads this
  // pointer when an event arrives; it is nil until then, and a nil module
  // drops the event.
  BGSRNNetworkFilterModule = self;
  // After the emitter exists. A log filter installed earlier reads this
  // pointer when a line arrives; it is nil until then, and a nil module
  // drops the line.
  BGSRNLogFilterModule = self;
}

/// Identity-checked inside the bus: a reload can construct and attach the NEW
/// module before this one is invalidated, and an unconditional clear would then
/// silence the live bridge.
- (void)invalidate {
  // No super call: `invalidate` comes from RCTInvalidating, and
  // NativeBugseeSpecBase inherits NSObject, which does not declare it.
  [BGSRNEventBus.shared detach:self];
  // Also completes every report handle this module's JS was given: the next
  // runtime cannot know them, so the reports must not wait out their
  // deadlines.
  [BGSRNReportHandlerBridge.shared detach:self];
  // And answers nil to every data request this module's JS was given, and
  // disables the view tree until the next runtime mounts its anchor.
  [BGSRNDataRequestBridge.shared detach:self];
  // The next runtime cannot know a created-report handle, and a slot left
  // reserved would make every later createReport reject busy.
  [BGSRNCreatedReports.shared clear];
  // Drop this module's unanswered network events. A reload may already have
  // attached the new module; only clear the pointer when it is still us.
  BGSRNDropNetworkFiltersOwnedBy(self);
  if (BGSRNNetworkFilterModule == self) {
    BGSRNNetworkFilterModule = nil;
  }
  // Drop this module's unanswered log lines. A reload may already have
  // attached the new module; only clear the pointer when it is still us.
  BGSRNDropLogFiltersOwnedBy(self);
  if (BGSRNLogFilterModule == self) {
    BGSRNLogFilterModule = nil;
  }
}

/// The SDK touches UIKit during start-up, so it must not be constructed on a
/// background queue. React Native honours this for module setup; the main-queue
/// hops below cover the method calls, which it does not.
+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (void)setSecureRectangles:(double)display
                coordinates:(NSArray *)coordinates {
  const NSUInteger count = coordinates.count;
  // Codegen hands numbers across as double, because that is what a JS number
  // is. Rounding rather than truncating: the JS side has already rounded each
  // edge outwards, and truncating would pull an edge back inside the region it
  // was widened to cover.
  int32_t *flat = count > 0 ? (int32_t *)malloc(count * sizeof(int32_t)) : NULL;
  if (count > 0 && flat == NULL) {
    return;
  }
  for (NSUInteger i = 0; i < count; i++) {
    flat[i] = (int32_t)llround([coordinates[i] doubleValue]);
  }

  [BGSRNSecureRectangles.shared setCoordinates:flat
                                         count:count
                                    forDisplay:(NSInteger)display];
  free(flat);
}

#pragma mark - Blackout and view-hierarchy capture (design doc §4.1)

// iOS honours startBlackout/endBlackout regardless of launch state, unlike
// Android, which ignores them (a logged no-op) before launch() resolves.
// Recorded in the plan as a candidate SDK issue, not patched here -- see the
// Phase 6 preamble's "Planner decisions".

- (void)startBlackout {
  BGSRNRunOnMain(^{
    [Bugsee startBlackout];
  });
}

- (void)endBlackout {
  BGSRNRunOnMain(^{
    [Bugsee endBlackout];
  });
}

- (void)isBlackout:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    resolve(@([Bugsee isBlackout]));
  });
}

- (void)captureViewHierarchy {
  BGSRNRunOnMain(^{
    [Bugsee captureViewHierarchy];
  });
}

#pragma mark - View-hierarchy data request (design doc Phase 6, Task 6.6)

/// JS mounted its first `Bugsee.wrap` anchor (YES) or unmounted its last (NO).
/// Until YES, the bridge answers the SDK nil without asking JS.
- (void)setViewTreeEnabled:(BOOL)enabled {
  [BGSRNDataRequestBridge.shared setViewTreeEnabled:enabled forSink:self];
}

/// JS's one synchronous answer to `onDataRequest`: the view tree as JSON
/// text, or `nil`. A late, repeated or unknown id is dropped by the bridge.
/// Runs on the module's method queue and never hops to main: the SDK is not
/// waiting on main, and a hop would only spend the deadline queueing behind
/// UI work.
- (void)replyDataRequest:(NSString *)requestId
                  payload:(NSString * _Nullable)payload {
  [BGSRNDataRequestBridge.shared complete:requestId payload:payload];
}

- (void)setWrapperInfo:(NSDictionary *)identity {
  // The SDK holds the wrapper for the process's lifetime and reads it while
  // composing a report's environment, so this must be registered before
  // launch rather than alongside it. Through BGSRNSetWrapper, the one route
  // to `+setWrapper:` in this module. Not onlyIfAbsent: this is the
  // replacement of the thin identity `init` registered.
  BGSRNSetWrapper((id<BugseeWrapper>)[BGSRNWrapper wrapperWithIdentity:identity], NO);
}

- (void)launch:(NSString *)token
       options:(NSDictionary *)options
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  if (!BGSRNTokenIsUsable(token)) {
    reject(@"E_TOKEN", @"Bugsee.launch requires a non-empty app token", nil);
    return;
  }
  BGSRNRunOnMain(^{
    // launchWithToken: returns the instance, or nil when the SDK declines —
    // already running, or the token was rejected. Declining is a normal
    // outcome, so it resolves false rather than rejecting.
    Bugsee *instance = [Bugsee launchWithToken:token andOptions:options];
    resolve(@(instance != nil));
  });
}

- (void)relaunch:(NSDictionary *)options
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    // NOT relaunchWithDictionaryOptions:, which is void — the bridge would
    // have to resolve an unconditional YES, so `relaunch` would mean "the
    // call was made" on iOS and "the SDK restarted" on Android, for one JS
    // signature. optionsFrom: converts the same dictionary, and the started:
    // overload reports what actually happened.
    [Bugsee relaunchWithOptions:[BugseeOptions optionsFrom:options]
                        started:^(BOOL success) {
                          // Onto the main queue: the SDK invokes started: on
                          // whatever thread its stop completion happens to
                          // use, and resolve/reject must be called from the
                          // same queue this method hopped onto.
                          dispatch_async(dispatch_get_main_queue(), ^{
                            resolve(@(success));
                          });
                        }];
  });
}

- (void)stop:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    [Bugsee stop:^{
      resolve(@YES);
    }];
  });
}

- (void)getStatus:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    Bugsee *instance = [Bugsee sharedInstance];
    // No instance means the SDK was never launched, which is Stopped.
    BugseeStatus status = instance ? instance.status : BugseeStatusStopped;
    resolve(@(BGSRNStatusToWire(status)));
  });
}

- (void)getLaunchOptions:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    NSDictionary *options = [Bugsee getLaunchOptions] ?: @{};
#if DEBUG
    // The example's e2e reads these off the simulator console. Logging them
    // from the JS continuation of this call does not arrive there: the lines
    // on either side do, and these two do not. NSLog is what `simctl` streams.
    id duration = options[@"com.bugsee.option.config.duration"];
    id wifi = options[@"com.bugsee.option.config.wifi-only-upload"];
    NSString *wifiText = @"undefined";
    if ([wifi isKindOfClass:[NSNumber class]]) {
      wifiText = [(NSNumber *)wifi boolValue] ? @"true" : @"false";
    } else if ([wifi isKindOfClass:[NSString class]]) {
      wifiText = wifi;
    }
    NSLog(@"BUGSEE_E2E effective duration=%@ keys=%lu",
          duration ?: @"undefined", (unsigned long)options.count);
    NSLog(@"BUGSEE_E2E effective wifi-only-upload=%@", wifiText);
#endif
    resolve(options);
  });
}

- (void)testCrash {
  BGSRNRunOnMain(^{
    [Bugsee testCrash];
  });
}

/// A handled JS exception. `payloadJson` is the Task 7.1a payload, forwarded
/// verbatim as the reason; `optionsJson` is `{domain?, labels?, includeVideo?}`
/// or null. Unparseable options are logged and the exception is still sent
/// with nil options — a void method has no promise to reject.
- (void)logException:(NSString *)payloadJson
         optionsJson:(NSString * _Nullable)optionsJson {
  BGSRNRunOnMain(^{
    NSError *error = nil;
    BugseeExceptionLoggingOptions *opts =
        [BGSRNExceptions loggingOptionsFromJSON:optionsJson error:&error];
    if (optionsJson != nil && opts == nil) {
      NSLog(@"BugseeRN exception options unparseable: %@", error.localizedDescription);
    }
    [Bugsee logException:BGSRNReactNativeExceptionName
                  reason:payloadJson
                 options:opts
              completion:nil];
    NSUInteger bytes = [payloadJson lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    NSLog(@"BugseeRN exception handled sent bytes=%lu", (unsigned long)bytes);
  });
}

/// An unhandled JS exception. The call stores `override_report.plcrash`.
/// iOS SDK 7.0.0-beta3 `0d9c9d0a-9` claims only `live_report.plcrash` on the
/// next launch, so that report is not recovered. Do not copy one file onto
/// the other. The completion is wrapped in `BGSRNSettleOnce`: on the
/// simulator the SDK compiles `logUnhandledException` out and never calls
/// this completion (verified facts), and a promise must still settle.
- (void)logUnhandledException:(NSString *)payloadJson
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    NSUInteger bytes = [payloadJson lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    NSLog(@"BugseeRN exception unhandled sent bytes=%lu", (unsigned long)bytes);
    dispatch_block_t done =
        BGSRNSettleOnce(BGSRNUnhandledCompletionDeadlineMs, dispatch_get_main_queue(), ^{
          NSLog(@"BugseeRN exception unhandled completed");
          resolve(nil);
        });
    [Bugsee logUnhandledException:BGSRNReactNativeExceptionName
                           reason:payloadJson
                       completion:done];
  });
}

/// JS has already checked both strings, the severity range and the labels.
/// Severity 0 is resolved here: the requested value, else the launch option
/// `BugseeOptionReportingDefaultBugPriority`, else High. On main, like every
/// other SDK entry point. Does nothing before launch -- the SDK returns.
/// The report it creates is a LIVE one, so its handlers run on main too,
/// after this returns.
- (void)upload:(NSString *)summary
    description:(NSString *)description
       severity:(double)severity
         labels:(NSArray *)labels {
  BGSRNRunOnMain(^{
    [Bugsee uploadWithSummary:summary
                  description:description
                     severity:(BugseeSeverityLevel)BGSRNUploadSeverity((NSInteger)severity,
                                                                       [Bugsee getLaunchOptions])
                       labels:BGSRNStringArray(labels)];
  });
}

/// Every argument absent (`nil`, `nil`, `0`, `nil`) calls the no-argument
/// dialog. Otherwise an omitted summary or description stays `nil`: beta3
/// writes the field only when the pointer is non-nil, and `@""` would
/// pre-fill an empty string. A 0 severity is left for the SDK to skip.
/// On main. Does nothing before launch. The dialog runs
/// `onBeforeReportCreated` before it opens.
- (void)showReportDialog:(NSString *)summary
             description:(NSString *)description
                severity:(double)severity
                  labels:(NSArray *)labels {
  BGSRNRunOnMain(^{
    if (summary == nil && description == nil && severity == 0.0 && labels == nil) {
      [Bugsee showReportDialog];
      return;
    }
    [Bugsee showReportDialogWithSummary:summary
                            description:description
                               severity:(BugseeSeverityLevel)severity
                                 labels:BGSRNStringArray(labels)];
  });
}

/// Records a named event, with optional params.
///
/// `paramsJson` is the params as JSON text (`src/bridge/json.ts`), parsed by
/// `BGSRNJSONObject`. Not an `NSDictionary` argument: React Native's
/// conversion of one drops every member whose JS value is `null`, so
/// `{ nil: null }` reached the SDK as `{}` here while Android kept it. Parsed
/// text keeps it as `NSNull`. Text that does not parse drops the event,
/// logged: a void method has no promise to reject.
///
/// `paramsJson` is `nil` exactly when JS sent `null` (no params given) rather
/// than `'{}'` -- the bundle's event entry has no `params` key at all when
/// none were given (design doc, Phase 4 bundle facts). JS has already
/// validated params against the accepted value domain and copied it
/// (`src/data/validate.ts`), so nothing here is re-checked. On main, like
/// every other SDK entry point.
- (void)event:(NSString *)name
   paramsJson:(NSString * _Nullable)paramsJson {
  NSDictionary *params = nil;
  if (paramsJson != nil) {
    NSError *error = nil;
    params = BGSRNJSONObject(paramsJson, &error);
    if (params == nil) {
      NSLog(@"BugseeRN event \"%@\" dropped: its params are not a JSON object: %@", name,
            error.localizedDescription);
      return;
    }
  }
  BGSRNRunOnMain(^{
    [Bugsee event:name params:params];
  });
}

/// A numeric trace value, boxed the ordinary way -- `@(value)` for a
/// `double` always produces a plain `NSNumber`, not a `CFBoolean`, so there is
/// no identity hazard here the way there is for `traceBoolean:value:` below.
- (void)traceNumber:(NSString *)name
              value:(double)value {
  BGSRNRunOnMain(^{
    [Bugsee trace:name value:@(value)];
  });
}

/// A string trace value.
- (void)traceString:(NSString *)name
              value:(NSString *)value {
  BGSRNRunOnMain(^{
    [Bugsee trace:name value:value];
  });
}

/// A boolean trace value, through `BGSRNBoolNumber` -- kept apart from
/// `traceNumber:value:` so it cannot silently arrive as `0`/`1`, and boxed
/// through the CFBoolean singleton rather than `@(value)` so the SDK's JSON
/// writer, which special-cases `CFBoolean` by object identity, actually
/// serialises it as `true`/`false`.
- (void)traceBoolean:(NSString *)name
               value:(BOOL)value {
  BGSRNRunOnMain(^{
    [Bugsee trace:name value:BGSRNBoolNumber(value)];
  });
}

/// Forwards a JS log line through the wrapper channel (tag nil,
/// `BGSLogEventSourceCustom`, level by value -- see `BGSRNWrapperChannelHolder`).
///
/// `level` arrives as `double` because that is what a JS number is; JS
/// already restricts it to the 1-5 wire values (`forwardLog` in
/// `wrapper/channel.ts`), but rounding rather than truncating matches the
/// caution taken with secure-rectangle coordinates above -- a stray fraction
/// should land on the nearest level, not be chopped toward one.
- (void)wrapperLog:(NSString *)message
             level:(double)level {
  // This filter request is the channel line (the patch, or Bugsee.log).
  // It is kept. An equal echo that is not this request is dropped once.
  // Bugsee.log does not arm a note of its own.
  BGSRNBeginChannelLine(message);
  [BGSRNWrapperChannelHolder.shared logMessage:message level:(NSInteger)llround(level)];
}

- (void)noteConsoleEcho:(NSString *)message {
  BGSRNNoteConsoleEcho(message);
}


/// `setNetworkEventFilter:`, the method the iOS SDK installs a network filter
/// with. `enabled` registers the bridge; `NO` passes nil, which removes it.
/// The write is synchronized and does not need the main queue, so it happens
/// before this method returns: a later Bugsee call on the same turn already
/// sees the filter. The block returns without waiting on JS. There is no
/// deadline here.
- (void)setNetworkFilterEnabled:(BOOL)enabled {
  if (enabled) {
    @synchronized (BGSRNNetworkFilterLock()) {
      if (BGSRNNetworkFilterInstalled) {
        return;
      }
      BGSRNNetworkFilterInstalled = YES;
    }
    [Bugsee setNetworkEventFilter:^(BugseeNetworkEvent *event, BugseeNetworkFilterDecisionBlock decision) {
        if (decision == nil) {
          return;
        }
        if (event == nil) {
          decision(nil);
          return;
        }
        BugseeModule *module = BGSRNNetworkFilterModule;
        if (module == nil) {
          decision(nil);
          return;
        }
        NSString *eventJson = BGSRNNetworkEventJSON(event);
        if (eventJson == nil) {
          decision(nil);
          return;
        }
        BGSRNNetworkFilterPending *item = [BGSRNNetworkFilterPending new];
        item.event = event;
        item.decision = decision;
        item.owner = module;
        NSString *requestId = nil;
        @synchronized (BGSRNNetworkFilterLock()) {
          BGSRNNetworkFilterNextId += 1;
          requestId = [NSString stringWithFormat:@"%lld", BGSRNNetworkFilterNextId];
          BGSRNNetworkFilterPendingTable[requestId] = item;
        }
        const BOOL delivered = [module emitNetworkFilterRequest:requestId eventJson:eventJson];
        if (!delivered) {
          BugseeNetworkFilterDecisionBlock drop = nil;
          @synchronized (BGSRNNetworkFilterLock()) {
            BGSRNNetworkFilterPending *removed = BGSRNNetworkFilterPendingTable[requestId];
            [BGSRNNetworkFilterPendingTable removeObjectForKey:requestId];
            drop = removed.decision;
          }
          if (drop != nil) {
            drop(nil);
          }
        }
  }];
  return;
  }
  @synchronized (BGSRNNetworkFilterLock()) {
    BGSRNNetworkFilterInstalled = NO;
  }
  [Bugsee setNetworkEventFilter:nil];
}

- (BOOL)emitNetworkFilterRequest:(NSString *)requestId eventJson:(NSString *)eventJson {
  NSDictionary *payload = @{ @"requestId" : requestId, @"eventJson" : eventJson };
  return BGSRNGuardedEmit(^{
    [self emitOnNetworkFilterRequest:payload];
  }, @"onNetworkFilterRequest");
}

/// `eventJson` nil drops. A JSON object is written onto the same event, so
/// the timestamp stays. A second reply is a no-op. A late reply still
/// records: this method does not expire the decision.
- (void)replyNetworkFilter:(NSString *)requestId eventJson:(NSString * _Nullable)eventJson {
  if (requestId == nil) {
    return;
  }
  BGSRNNetworkFilterPending *item = nil;
  @synchronized (BGSRNNetworkFilterLock()) {
    item = BGSRNNetworkFilterPendingTable[requestId];
    if (item != nil) {
      [BGSRNNetworkFilterPendingTable removeObjectForKey:requestId];
    }
  }
  if (item.decision == nil) {
    return;
  }
  if (eventJson == nil) {
    item.decision(nil);
    return;
  }
  if (!BGSRNApplyNetworkReplacement(item.event, eventJson)) {
    item.decision(nil);
    return;
  }
  item.decision(item.event);
}

/// A network event the app recorded itself. The bridge stamps the time in
/// epoch milliseconds and builds a `BugseeNetworkEvent`. Beta3's exchange
/// factory `createNetworkEvent` always returns nil, so this does not call it.
/// The event is submitted with filtering required. The one-argument
/// `addNetworkEvent:` passes NO and is not used. There is no timer that
/// would pass the original through.
- (void)addNetworkEvent:(NSString *)eventJson {
  NSError *error = nil;
  NSDictionary *object = BGSRNJSONObject(eventJson, &error);
  if (object == nil) {
    return;
  }
  BGSRNNetworkEventOutcome outcome = BGSRNRecordNetworkEvent(
      object,
      ^(BugseeNetworkEvent *event, BOOL requiresFiltering) {
        if (!requiresFiltering) {
          return;
        }
        [Bugsee addNetworkEvent:event requiresFiltering:YES];
      },
      [[NSDate date] timeIntervalSince1970] * 1000.0);
  if (outcome == BGSRNNetworkEventOutcomeNoEvent) {
    NSLog(@"BugseeRN addNetworkEvent dropped: the SDK made no event");
  }
}

- (void)setLogFilterEnabled:(BOOL)enabled {
  if (enabled) {
    @synchronized (BGSRNLogFilterLock()) {
      if (BGSRNLogFilterInstalled) {
        return;
      }
      BGSRNLogFilterInstalled = YES;
    }
    [Bugsee setLogEventFilter:^(BugseeLogEvent *event, BugseeLogFilterDecisionBlock decision) {
        NSString *line = event.text;
        if (decision == nil) {
          return;
        }
        if (line == nil) {
          decision(nil);
          return;
        }
        // The console echo. Dropped here, before JS is asked, so the user's
        // callback runs once. Not a timeout: the line is not passed through.
        if (BGSRNDropConsoleEcho(line)) {
          decision(nil);
          return;
        }
        BugseeModule *module = BGSRNLogFilterModule;
        if (module == nil) {
          decision(nil);
          return;
        }
        BGSRNLogFilterPending *item = [BGSRNLogFilterPending new];
        item.event = event;
        item.decision = decision;
        item.owner = module;
        NSString *requestId = nil;
        @synchronized (BGSRNLogFilterLock()) {
          BGSRNLogFilterNextId += 1;
          requestId = [NSString stringWithFormat:@"%lld", BGSRNLogFilterNextId];
          BGSRNLogFilterPendingTable[requestId] = item;
        }
        const BOOL delivered = [module emitLogFilterRequest:requestId line:line];
        if (!delivered) {
          BugseeLogFilterDecisionBlock drop = nil;
          @synchronized (BGSRNLogFilterLock()) {
            BGSRNLogFilterPending *removed = BGSRNLogFilterPendingTable[requestId];
            [BGSRNLogFilterPendingTable removeObjectForKey:requestId];
            drop = removed.decision;
          }
          if (drop != nil) {
            drop(nil);
          }
        }
      }];
    return;
  }
  @synchronized (BGSRNLogFilterLock()) {
    BGSRNLogFilterInstalled = NO;
  }
  [Bugsee setLogEventFilter:nil];
}

- (BOOL)emitLogFilterRequest:(NSString *)requestId line:(NSString *)line {
  NSDictionary *payload = @{ @"requestId" : requestId, @"line" : line };
  return BGSRNGuardedEmit(^{
    [self emitOnLogFilterRequest:payload];
  }, @"onLogFilterRequest");
}

/// `line` nil drops. A string is written onto the same event, so the level
/// and the timestamp stay. If the write does not stick, the line is dropped
/// rather than kept unredacted. A second reply is a no-op.
- (void)replyLogFilter:(NSString *)requestId line:(NSString * _Nullable)line {
  if (requestId == nil) {
    return;
  }
  BGSRNLogFilterPending *item = nil;
  @synchronized (BGSRNLogFilterLock()) {
    item = BGSRNLogFilterPendingTable[requestId];
    if (item != nil) {
      [BGSRNLogFilterPendingTable removeObjectForKey:requestId];
    }
  }
  if (item.decision == nil) {
    return;
  }
  if (line == nil) {
    item.decision(nil);
    return;
  }
  item.event.text = line;
  if (![item.event.text isEqualToString:line]) {
    item.decision(nil);
    return;
  }
  item.decision(item.event);
}


#pragma mark - Attributes and identity

- (void)setAttributeString:(NSString *)name
                      value:(NSString *)value
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  BGSRNSetAttribute(name, value, resolve, reject);
}

/// `@(value)`: iOS stores a double exactly, so unlike Android's `AttributeBridge
/// .numberValue`, no integral conversion is needed to avoid a rounding trip.
- (void)setAttributeNumber:(NSString *)name
                      value:(double)value
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  BGSRNSetAttribute(name, @(value), resolve, reject);
}

/// Through `BGSRNBoolNumber`, the CFBoolean singleton -- see `traceBoolean:
/// value:` above for why a plain `@(value)` boxing is not good enough here
/// either.
- (void)setAttributeBoolean:(NSString *)name
                       value:(BOOL)value
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  BGSRNSetAttribute(name, BGSRNBoolNumber(value), resolve, reject);
}

/// Reads through `+getAllAttributes`, filtered by `BGSRNAttributes readable:`,
/// rather than `+getAttribute:` -- the one persisted source `getAllAttributes`
/// below also reads, so a single attribute and the whole set never disagree
/// about what survived filtering (mirrors Android's `AttributeBridge.readOne`,
/// which reads the persisted copy for the same reason).
- (void)getAttribute:(NSString *)name
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    id value = [BGSRNAttributes readable:[Bugsee getAllAttributes]][name];
    resolve(value != nil ? @{ @"value" : value } : @{});
  });
}

- (void)getAllAttributes:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    resolve([BGSRNAttributes readable:[Bugsee getAllAttributes]]);
  });
}

- (void)clearAttribute:(NSString *)name
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    [Bugsee clearAttribute:name];
    resolve(nil);
  });
}

- (void)clearAllAttributes:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    [Bugsee clearAllAttributes];
    resolve(nil);
  });
}

- (void)setUserIdentifier:(NSString *)identifier {
  BGSRNRunOnMain(^{
    [Bugsee setUserIdentifier:identifier];
  });
}

/// `nil`/`@""` both read as absent (`BGSRNAttributes identifier:`) -- iOS's
/// own getter already never returns `@""`, but this keeps the rule explicit
/// and in parity with Android.
- (void)getUserIdentifier:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    NSString *identifier = [BGSRNAttributes identifier:[Bugsee getUserIdentifier]];
    resolve(identifier != nil ? @{ @"value" : identifier } : @{});
  });
}

- (void)clearUserIdentifier {
  BGSRNRunOnMain(^{
    [Bugsee clearUserIdentifier];
  });
}

/// Which phases JS wants delivered; the other completes natively at once.
- (void)setReportHandlerPhases:(BOOL)before
                         after:(BOOL)after {
  [BGSRNReportHandlerBridge.shared setPhasesBefore:before after:after];
}

/// A second call for the same handle is a no-op in the bridge.
///
/// Never hops to main -- not because the SDK is blocked on main waiting for
/// this (it isn't: the live handler runs on main via `dispatch_async`, but
/// its completion is a thread-agnostic run-once that hops to a private queue,
/// so main is never held for it), but because there is no need to, and an op
/// that did would queue behind whatever UI work is already on main, eating
/// into the handle's deadline for nothing. Neither do the report ops below:
/// they run on this module's method queue, which is safe because the report
/// contract's methods are lock-synchronized (BGSContracts.h). Each catches
/// everything: an exception escaping a TurboModule method is a crash in a
/// release build, and the SDK's fault is not worth the app.
- (void)completeReportHandler:(NSString *)handleId {
  [BGSRNReportHandlerBridge.shared complete:handleId];
}

- (void)reportRead:(NSString *)handleId
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  id<BGSReportContract> report = [BGSRNReportHandlerBridge.shared reportFor:handleId];
  if (report == nil) {
    BGSRNRejectHandleDead(reject);
    return;
  }
  @try {
    resolve([BGSRNReportOps readReport:report]);
  } @catch (NSException *exception) {
    BGSRNRejectException(reject, exception);
  }
}

/// `patchJson` is JSON text (`src/bridge/json.ts`), not an `NSDictionary`:
/// React Native's object-argument conversion drops a `null` member, which
/// here means "clear the summary" or "remove this attribute" -- so those
/// edits silently did nothing. Text that is not a JSON object rejects
/// `E_REPORT_BAD_ARGUMENT`, like any malformed field.
- (void)reportUpdate:(NSString *)handleId
           patchJson:(NSString *)patchJson
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  id<BGSReportContract> report = [BGSRNReportHandlerBridge.shared reportFor:handleId];
  if (report == nil) {
    BGSRNRejectHandleDead(reject);
    return;
  }
  @try {
    NSError *error = nil;
    if ([BGSRNReportOps applyPatchJSON:patchJson toReport:report error:&error]) {
      resolve(nil);
    } else {
      reject(BGSRNReportErrorWireCode(error), error.localizedDescription, nil);
    }
  } @catch (NSException *exception) {
    BGSRNRejectException(reject, exception);
  }
}

- (void)reportAddFileAttachment:(NSString *)handleId
                            path:(NSString *)path
                            name:(NSString *)name
                        mimeType:(NSString * _Nullable)mimeType
                            move:(BOOL)move
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject {
  id<BGSReportContract> report = [BGSRNReportHandlerBridge.shared reportFor:handleId];
  if (report == nil) {
    BGSRNRejectHandleDead(reject);
    return;
  }
  @try {
    NSError *error = nil;
    const BOOL added = [BGSRNReportOps addFileAtPath:path
                                                name:name
                                            mimeType:mimeType
                                                move:move
                                            toReport:report
                                               error:&error];
    BGSRNSettleAttachment(handleId, added, error, resolve, reject);
  } @catch (NSException *exception) {
    BGSRNRejectException(reject, exception);
  }
}

- (void)reportAddDataAttachment:(NSString *)handleId
                          base64:(NSString *)base64
                            name:(NSString *)name
                        mimeType:(NSString * _Nullable)mimeType
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject {
  id<BGSReportContract> report = [BGSRNReportHandlerBridge.shared reportFor:handleId];
  if (report == nil) {
    BGSRNRejectHandleDead(reject);
    return;
  }
  @try {
    NSError *error = nil;
    const BOOL added = [BGSRNReportOps addData:base64
                                          name:name
                                      mimeType:mimeType
                                      toReport:report
                                         error:&error];
    BGSRNSettleAttachment(handleId, added, error, resolve, reject);
  } @catch (NSException *exception) {
    BGSRNRejectException(reject, exception);
  }
}

/// On main, unlike the handler's report ops. `BugseeExtendedReport` is
/// unsynchronised, and the SDK hands it out and takes it back on main.
///
/// `reserve` runs before that hop. `invalidate` calls `clear` on another
/// queue and cannot cancel a block already queued. Reserving inside the
/// block would run after that clear and hold the slot for a handle the
/// torn-down JS will never upload.
- (void)createReport:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  BGSRNCreatedReports *registry = BGSRNCreatedReports.shared;
  const NSUInteger reservation = [registry reserve];
  if (reservation == 0) {
    NSLog(@"BugseeRN created report - busy");
    reject(kCreateBusyCode, @"a created report is already outstanding", nil);
    return;
  }
  BGSRNRunOnMain(^{
    // One check with the mark. `clear` between an open test and the SDK call
    // would still `-init` a `BugseeExtendedReport`. NO means `clear` already
    // dropped this token and freed the slot. YES means `clear` from here on
    // keeps the slot until `fulfil`, and that fulfil does not publish.
    if (![registry beginCreate:reservation]) {
      NSLog(@"BugseeRN created report - reservation ended");
      resolve(nil);
      return;
    }
    @try {
      // Captured above, before the hop. `invalidate` clears the registry
      // without cancelling this completion. Once `beginCreate:` has run, that
      // clear keeps the slot and this fulfil must not mint a handle.
      // The completion runs on every path, with nil when the SDK is not launched.
      [Bugsee createReportWithCompletion:^(BugseeExtendedReport *report) {
        NSString *handle = [registry fulfil:report reservation:reservation];
        if (handle == nil) {
          NSLog(@"BugseeRN created report - none");
          resolve(nil);
        } else {
          NSLog(@"BugseeRN created report %@ created", handle);
          resolve(handle);
        }
      }];
    } @catch (NSException *exception) {
      [registry fulfil:nil reservation:reservation];
      BGSRNRejectException(reject, exception);
    }
  });
}

- (void)createdReportRead:(NSString *)handleId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    @try {
      BugseeExtendedReport *report = [BGSRNCreatedReports.shared reportFor:handleId];
      if (report == nil) {
        BGSRNRejectCreatedHandleDead(reject);
        return;
      }
      resolve([BGSRNCreatedReportOps readReport:report]);
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, exception);
    }
  });
}
- (void)createdReportUpdate:(NSString *)handleId
                  patchJson:(NSString *)patchJson
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    @try {
      BugseeExtendedReport *report = [BGSRNCreatedReports.shared reportFor:handleId];
      if (report == nil) {
        BGSRNRejectCreatedHandleDead(reject);
        return;
      }
      NSError *error = nil;
      if ([BGSRNCreatedReportOps applyPatchJSON:patchJson toReport:report error:&error]) {
        resolve(nil);
      } else {
        reject(BGSRNReportErrorWireCode(error), error.localizedDescription, nil);
      }
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, exception);
    }
  });
}

/// `mimeType` is accepted because JS sends it. `BugseeAttachment` has no type,
/// and iOS drops it (P7).
- (void)createdReportAddDataAttachment:(NSString *)handleId
                                base64:(NSString *)base64
                                  name:(NSString *)name
                              mimeType:(NSString * _Nullable)mimeType
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject {
  (void)mimeType;
  BGSRNRunOnMain(^{
    @try {
      BugseeExtendedReport *report = [BGSRNCreatedReports.shared reportFor:handleId];
      if (report == nil) {
        BGSRNRejectCreatedHandleDead(reject);
        return;
      }
      NSError *error = nil;
      if ([BGSRNCreatedReportOps addData:base64 name:name toReport:report error:&error]) {
        resolve(nil);
      } else {
        reject(BGSRNReportErrorWireCode(error), error.localizedDescription, nil);
      }
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, exception);
    }
  });
}

/// No `move`: the bytes are copied at add time. `mimeType` is ignored (P7).
- (void)createdReportAddFileAttachment:(NSString *)handleId
                                  path:(NSString *)path
                                  name:(NSString *)name
                              mimeType:(NSString * _Nullable)mimeType
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject {
  (void)mimeType;
  BGSRNRunOnMain(^{
    @try {
      BugseeExtendedReport *report = [BGSRNCreatedReports.shared reportFor:handleId];
      if (report == nil) {
        BGSRNRejectCreatedHandleDead(reject);
        return;
      }
      NSError *error = nil;
      if ([BGSRNCreatedReportOps addFileAtPath:path name:name toReport:report error:&error]) {
        resolve(nil);
      } else {
        reject(BGSRNReportErrorWireCode(error), error.localizedDescription, nil);
      }
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, exception);
    }
  });
}

- (void)createdReportUpload:(NSString *)handleId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    NSUInteger generation = 0;
    @try {
      BugseeExtendedReport *report =
          [BGSRNCreatedReports.shared detachForUpload:handleId generation:&generation];
      if (report == nil) {
        BGSRNRejectCreatedHandleDead(reject);
        return;
      }
      // The handle is already dead. The slot stays taken until this upload
      // ends: a second created report would reset beta3's file-scope attributes
      // before `uploadReport:` copies them. The completion carries no success
      // flag. It runs once the report is handed off, including when the SDK
      // was not launched (it calls back immediately). `ok` is YES on that path.
      [Bugsee uploadReport:report completion:^{
        [BGSRNCreatedReports.shared endUpload:generation];
        NSLog(@"BugseeRN created report %@ uploaded ok=%@", handleId, @YES);
        resolve(@YES);
      }];
    } @catch (NSException *exception) {
      [BGSRNCreatedReports.shared endUpload:generation];
      BGSRNRejectException(reject, exception);
    }
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  auto module = std::make_shared<facebook::react::NativeBugseeSpecJSI>(params);
  // Only now is the codegen event emitter set: see attachToBridges.
  [self attachToBridges];
  return module;
}

@end
