#import "BugseeModule.h"
#import "BGSRNConsoleCapture.h"

// Header imports, not `@import`. This file is ObjC++, and neither delivery path
// turns on C++ modules — CocoaPods sets CLANG_ENABLE_MODULES for ObjC only, and
// the SPM target does not pass -fcxx-modules either. A module import here fails
// with "use of '@import' when C++ modules are disabled", and then with a
// cascade of undeclared identifiers that hides the real cause.
#import <Bugsee/Bugsee.h>
#import <UIKit/UIKit.h>
#import <os/lock.h>

// CocoaPods compiles BugseeRNSupport's sources straight into this pod, so its
// headers arrive flat; under SPM it is a separate target and they arrive under
// the module's own directory.
#if __has_include(<BugseeRNSupport/BGSRNTokens.h>)
#import <BugseeRNSupport/BGSRNMainThread.h>
#import <BugseeRNSupport/BGSRNWrapper.h>
#import <BugseeRNSupport/BGSRNWrapperChannelHolder.h>
#import <BugseeRNSupport/BGSRNStatusMapper.h>
#import <BugseeRNSupport/BGSRNSecureRectangles.h>
#import <BugseeRNSupport/BGSRNReactRootOriginTracker.h>
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
#import <BugseeRNSupport/BGSRNSpanHandles.h>
#import <BugseeRNSupport/BGSRNErrorMessage.h>
#else
#import "BGSRNMainThread.h"
#import "BGSRNWrapper.h"
#import "BGSRNWrapperChannelHolder.h"
#import "BGSRNStatusMapper.h"
#import "BGSRNSecureRectangles.h"
#import "BGSRNReactRootOriginTracker.h"
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
#import "BGSRNSpanHandles.h"
#import "BGSRNErrorMessage.h"
#endif

/// Forward-declared: the wrapper's pull path refreshes the origins before the
/// functions' definitions later in this file.
static NSValue *_Nullable BGSRNReactOrigin(void);
static NSValue *_Nullable BGSRNModalSurfaceOrigin(NSInteger surface);
static Class _Nullable BGSRNModalHostClass(void);
static BGSRNReactRootOriginTracker *BGSRNSecureOriginTracker(void);

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
/// little-endian int32, every rectangle moved from the React root's window to
/// the screen.
///
/// Read from the process-wide store rather than from this instance. The SDK
/// pulls on the MAIN thread once per captured frame, and the wrapper it pulls
/// through is replaced when `setWrapperInfo` runs — regions the app marked
/// secret must survive that swap. See `BGSRNSecureRectangles` for the version
/// contract, which is what makes the SDK notice a change at all.
- (NSData *)secureRectanglesForDisplay:(NSInteger)display {
  // Every surface's origin is re-read on the pull, so a window move or a
  // sheet settling still updates without waiting for the next JS publish,
  // the same reason Android refreshes at pull time. The main surface is the
  // React root's window; each <Modal> is its presented view controller's
  // view. A Modal whose host is gone takes its empty lane with it; one that
  // is not found yet keeps failing closed.
  if (NSThread.isMainThread) {
    BGSRNSecureRectangles *store = BGSRNSecureRectangles.shared;
    // What a surface whose origin is unknown serves: the screen, not more.
    [store setDisplaySize:UIScreen.mainScreen.bounds.size forDisplay:display];
    NSValue *origin = BGSRNReactOrigin();
    if (origin != nil) {
      [store setOrigin:origin.CGPointValue forDisplay:display];
    }
    for (NSNumber *surface in [store surfacesForDisplay:display]) {
      NSValue *modalOrigin = BGSRNModalSurfaceOrigin(surface.integerValue);
      if (modalOrigin != nil) {
        [store setOrigin:modalOrigin.CGPointValue forDisplay:display surface:surface.integerValue];
      } else {
        [store dropSurfaceIfEmpty:surface.integerValue];
      }
    }
  }
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

/// The `vh` origin: where the window hosting the React root starts in the
/// frame the SDK records (points), among the windows the SDK's own
/// view-hierarchy walk visits -- the space the SDK places every native node
/// in, so the two trees share one space by construction (see
/// `BGSRNReactWindow.h`). nil without one, or off main: the SDK asks on main,
/// and UIKit must not be read anywhere else.
///
/// The root is recognised by class name, not by import: `RCTSurfaceHostingView`
/// is the new architecture's root (the template's `RCTRootView` is its
/// `RCTSurfaceHostingProxyRootView` subclass); the legacy `RCTRootView` class
/// is matched too for interop hosts.
static BOOL BGSRNIsReactRoot(UIView *view) {
  static Class surfaceHostingView;
  static Class legacyRootView;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    surfaceHostingView = NSClassFromString(@"RCTSurfaceHostingView");
    legacyRootView = NSClassFromString(@"RCTRootView");
  });
  return (surfaceHostingView != Nil && [view isKindOfClass:surfaceHostingView]) ||
         (legacyRootView != Nil && [view isKindOfClass:legacyRootView]);
}

static NSValue *_Nullable BGSRNReactOrigin(void) {
  if (!NSThread.isMainThread) {
    return nil;
  }
  return [BGSRNSecureOriginTracker() origin];
}

/// `BGSRNReactOrigin`, searching for the root at once when the one found last
/// is in no window: for a `vh` request, which comes once per walk.
static NSValue *_Nullable BGSRNReactOriginFindingTheRoot(void) {
  if (!NSThread.isMainThread) {
    return nil;
  }
  return [BGSRNSecureOriginTracker() originFindingTheRoot];
}

/// `RCTModalHostViewComponentView`, resolved by name rather than imported;
/// Nil when this React Native has no such class.
static Class _Nullable BGSRNModalHostClass(void) {
  static Class modalHostClass;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    modalHostClass = NSClassFromString(@"RCTModalHostViewComponentView");
  });
  return modalHostClass;
}

/// Where `measureInWindow`'s (0, 0) sits on the screen, in points, for the
/// `<Modal>` whose host has React tag `surface` (`BGSRNModalHostOrigin`).
/// Read from the current runtime's host, which its module names at publish
/// time (`nameModalHostForSurface:`), the same shape as Android's
/// `watchSurface`: a window can hold another runtime's host with the same
/// tag during a reload, and only the module's own view registry tells them
/// apart. While that host has not mounted, unknown. Only without a
/// registry, the one class+tag match in the windows the SDK walks. nil (none or several, or off main) leaves the lane's
/// origin as it was: unknown for a new lane, which is served as the whole
/// display.
static NSValue *_Nullable BGSRNModalSurfaceOrigin(NSInteger surface) {
  if (!NSThread.isMainThread) {
    return nil;
  }
  Class modalHostClass = BGSRNModalHostClass();
  if (modalHostClass == Nil || surface <= 0) {
    return nil;
  }
  return BGSRNSecureSurfaceOrigin(
      BGSRNSecureRectangles.shared, surface, BGSRNSdkWalkedWindows(BGSRNSdkKeyWindow()),
      ^BOOL(UIView *view) {
        return [view isKindOfClass:modalHostClass];
      },
      ^NSValue *_Nullable(UIWindow *window) {
        return BGSRNWindowRecordedOrigin(window);
      });
}

/// Keeps the main surface's origin on the window JS measures in: the iOS
/// peer of Android's `ReactRootOriginTracker` (see
/// `BGSRNReactRootOriginTracker`). Process-wide, like the store it feeds: the
/// window lookup reads only UIKit, nothing of one module.
static BGSRNReactRootOriginTracker *BGSRNSecureOriginTracker(void) {
  static BGSRNReactRootOriginTracker *tracker = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    tracker = [[BGSRNReactRootOriginTracker alloc]
        initWithFindRoot:^UIView *_Nullable {
          UIWindow *keyWindow = BGSRNSdkKeyWindow();
          return BGSRNReactRootView(keyWindow,
                                    BGSRNSdkWalkedWindows(keyWindow),
                                    ^BOOL(UIView *view) {
                                      return BGSRNIsReactRoot(view);
                                    },
                                    BGSRNReactRootSearchBudget);
        }
        readOrigin:^NSValue *_Nullable(UIWindow *window) {
          return BGSRNWindowRecordedOrigin(window);
        }
        clock:^NSTimeInterval {
          return NSProcessInfo.processInfo.systemUptime;
        }];
  });
  return tracker;
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
/// `rejectReportFailure` does): an unexpected fault is not one of the codes the
/// JS contract names, and inventing another would make it matchable.
///
/// The message names `operation` only (`failureMessageForOperation:`), never
/// `exception.reason`, which can echo report content (a summary, an attribute
/// value, a file path, an attachment name). Only the exception's class is
/// logged.
static void BGSRNRejectException(RCTPromiseRejectBlock reject, NSString *operation, NSException *exception) {
  NSLog(@"BugseeRN %@ failed: %@", operation, NSStringFromClass(exception.class));
  reject(nil, [BGSRNReportOps failureMessageForOperation:operation], nil);
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
  reject(code, BGSRNErrorMessage(error), nil);
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
/** The JS round trip. Off is the native pass-through, which stays installed. */
static BOOL BGSRNLogFilterUserEnabled = NO;
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

/**
 * Declared up here so the filter installer, which sits above the method
 * body, can call it. The implementation is on BugseeModule.
 */
@interface BugseeModule (BGSRNLogFilterEmit)
- (BOOL)emitLogFilterRequest:(NSString *)requestId line:(NSString *)line;
@end

/**
 * Installs the native log filter once. It stays installed when the app has
 * no log callback: an echo is dropped, and every other line is returned
 * immediately. A user callback asks JS. Clearing that callback restores the
 * pass-through. The filter is not set back to nil.
 */
static void BGSRNInstallLogEventFilter(void) {
  @synchronized (BGSRNLogFilterLock()) {
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
      // The console echo. A stderr stamp, and one raw stdout or stderr line
      // of the noted text, are dropped here, before anything else is asked.
      // Not a timeout: the line is not passed through. A Custom line is not
      // that echo. `dictionary` is how the SDK stores the source on the
      // event. When it is absent, the source is unknown and a non-stamp line
      // is not dropped.
      NSInteger source = -1;
      SEL dictionarySelector = NSSelectorFromString(@"dictionary");
      if ([event respondsToSelector:dictionarySelector]) {
        id value = [event valueForKey:@"dictionary"];
        if ([value isKindOfClass:[NSDictionary class]]) {
          id raw = [(NSDictionary *)value objectForKey:@"source"];
          if ([raw respondsToSelector:@selector(integerValue)]) {
            source = [raw integerValue];
          }
        }
      }
      if (BGSRNDropConsoleEcho(line, source)) {
        decision(nil);
        return;
      }
      BOOL askJs = NO;
      @synchronized (BGSRNLogFilterLock()) {
        askJs = BGSRNLogFilterUserEnabled;
      }
      if (!askJs) {
        decision(event);
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
}

/// One in-flight breadcrumb-filter request. The decision block is copied: the
/// SDK's block argument is not guaranteed to outlive the filter call, and the
/// reply comes back later, from JS. There is no timer. The SDK does not time
/// the filter out, and a late decision still records.
@interface BGSRNBreadcrumbFilterPending : NSObject
@property (nonatomic, strong) id<BGSBreadcrumb> breadcrumb;
@property (nonatomic, copy) BugseeBreadcrumbFilterDecisionBlock decision;
@property (nonatomic, weak) BugseeModule *owner;
@end
@implementation BGSRNBreadcrumbFilterPending
@end

static __weak BugseeModule *BGSRNBreadcrumbFilterModule = nil;
static BOOL BGSRNBreadcrumbFilterInstalled = NO;
/// Bumped on every enable and every disable. A disable queued on main nils
/// the filter only when this is still the generation it captured, so a later
/// enable is not wiped by a nil that was already queued.
static int64_t BGSRNBreadcrumbFilterGeneration = 0;
static NSMutableDictionary<NSString *, BGSRNBreadcrumbFilterPending *> *BGSRNBreadcrumbFilterPendingTable;
static int64_t BGSRNBreadcrumbFilterNextId = 0;
/// The `addId` of the manual add currently inside `[Bugsee addBreadcrumb:]`.
/// The filter block copies it onto that one request. SDK crumbs are filtered
/// outside this window, so their requests omit it.
static NSString *BGSRNBreadcrumbManualAddId = nil;

static id BGSRNBreadcrumbFilterLock(void) {
  static id lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [NSObject new];
    BGSRNBreadcrumbFilterPendingTable = [NSMutableDictionary dictionary];
  });
  return lock;
}

/// Answers `nil` for every request `module` still holds, which drops the crumb.
/// Called outside the lock: the SDK's decision block must not re-enter it.
/// This is teardown, not a timeout.
static void BGSRNDropBreadcrumbFiltersOwnedBy(BugseeModule *module) {
  NSMutableArray<BugseeBreadcrumbFilterDecisionBlock> *decisions = [NSMutableArray array];
  @synchronized (BGSRNBreadcrumbFilterLock()) {
    for (NSString *key in BGSRNBreadcrumbFilterPendingTable.allKeys) {
      BGSRNBreadcrumbFilterPending *item = BGSRNBreadcrumbFilterPendingTable[key];
      if (item.owner == module) {
        [BGSRNBreadcrumbFilterPendingTable removeObjectForKey:key];
        if (item.decision != nil) {
          [decisions addObject:item.decision];
        }
      }
    }
  }
  for (BugseeBreadcrumbFilterDecisionBlock decision in decisions) {
    decision(nil);
  }
}

/// `BugseeLogLevel`, not Android `Breadcrumb.Level.getValue()`.
/// error 1, warning 2, info 3, debug 4. `fatal` has no rung and is stored
/// as error (1). Verbose (5) is not a JS name; a stored verbose reads back
/// as `debug`, which is how the bundle folds it. 0 and anything else have
/// no name.
static NSString *BGSRNBreadcrumbLevelName(NSInteger level) {
  switch (level) {
    case 1: return @"error";
    case 2: return @"warning";
    case 3: return @"info";
    case 4: return @"debug";
    case 5: return @"debug";
    default: return nil;
  }
}

/// The integer to store for a JS level name. `fatal` is 1. NO when `name`
/// is not one of the names.
static BOOL BGSRNBreadcrumbLevelFromName(NSString *name, NSInteger *out) {
  if ([name isEqualToString:@"error"] || [name isEqualToString:@"fatal"]) {
    *out = 1;
    return YES;
  }
  if ([name isEqualToString:@"warning"]) {
    *out = 2;
    return YES;
  }
  if ([name isEqualToString:@"info"]) {
    *out = 3;
    return YES;
  }
  if ([name isEqualToString:@"debug"]) {
    *out = 4;
    return YES;
  }
  return NO;
}

/// The crumb as JSON, with only the keys the SDK actually set. `level` is
/// the JS name (0 means unset and is omitted). An integer that has no name
/// drops the snapshot, rather than sending that integer. A zero timestamp
/// is omitted. Nil when the crumb cannot be serialised: the caller drops it
/// rather than sending a partial snapshot.
static NSString *BGSRNBreadcrumbSnapshotJson(id<BGSBreadcrumb> crumb) {
  if (crumb == nil) {
    return nil;
  }
  NSMutableDictionary *object = [NSMutableDictionary dictionary];
  if (crumb.category != nil) {
    object[@"category"] = crumb.category;
  }
  if (crumb.level != 0) {
    NSString *name = BGSRNBreadcrumbLevelName(crumb.level);
    if (name == nil) {
      return nil;
    }
    object[@"level"] = name;
  }
  if (crumb.message != nil) {
    object[@"message"] = crumb.message;
  }
  if (crumb.type != nil) {
    object[@"type"] = crumb.type;
  }
  if (crumb.data != nil) {
    object[@"data"] = crumb.data;
  }
  if (crumb.timestamp != 0) {
    object[@"timestamp"] = @(crumb.timestamp);
  }
  if (![NSJSONSerialization isValidJSONObject:object]) {
    return nil;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (data == nil) {
    return nil;
  }
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

/// Writes the keys `kept` names onto `breadcrumb`. A key it omits stays.
/// `timestamp` is read-only and is not written. Returns NO when a write is
/// the wrong type or does not stick, so the caller can drop the crumb.
static BOOL BGSRNApplyBreadcrumbKeep(id<BGSBreadcrumb> breadcrumb, NSDictionary *kept) {
  id category = kept[@"category"];
  if (category != nil) {
    if (![category isKindOfClass:NSString.class]) {
      return NO;
    }
    breadcrumb.category = (NSString *)category;
    if (![breadcrumb.category isEqualToString:category]) {
      return NO;
    }
  }
  id message = kept[@"message"];
  if (message != nil) {
    if (![message isKindOfClass:NSString.class]) {
      return NO;
    }
    breadcrumb.message = (NSString *)message;
    if (![breadcrumb.message isEqualToString:message]) {
      return NO;
    }
  }
  id type = kept[@"type"];
  if (type != nil) {
    if (![type isKindOfClass:NSString.class]) {
      return NO;
    }
    breadcrumb.type = (NSString *)type;
    if (![breadcrumb.type isEqualToString:type]) {
      return NO;
    }
  }
  id level = kept[@"level"];
  if (level != nil) {
    // The keep echoes the name. An Android integer is not a level here.
    if (![level isKindOfClass:NSString.class]) {
      return NO;
    }
    NSInteger value = 0;
    if (!BGSRNBreadcrumbLevelFromName((NSString *)level, &value)) {
      return NO;
    }
    breadcrumb.level = value;
    if (breadcrumb.level != value) {
      return NO;
    }
  }
  if ([kept objectForKey:@"data"] != nil) {
    id data = kept[@"data"];
    if (data == [NSNull null]) {
      breadcrumb.data = nil;
      if (breadcrumb.data != nil) {
        return NO;
      }
    } else if ([data isKindOfClass:NSDictionary.class]) {
      breadcrumb.data = (NSDictionary *)data;
      if (breadcrumb.data == nil) {
        return NO;
      }
    } else {
      return NO;
    }
  }
  return YES;
}

@interface BGSRNLiveSpan : NSObject <BGSRNRetainedSpan>
@property (nonatomic, readonly) id<BGSSpan> span;
- (instancetype)initWithSpan:(id<BGSSpan>)span;
@end

@implementation BGSRNLiveSpan {
  id<BGSSpan> _span;
}

- (instancetype)initWithSpan:(id<BGSSpan>)span {
  self = [super init];
  if (self != nil) {
    _span = span;
  }
  return self;
}

- (id<BGSSpan>)span {
  return _span;
}

- (void)bgsrnFinishWithStatus:(NSNumber *)status {
  if (status == nil) {
    [_span finish];
    return;
  }
  [_span finishWithStatus:(BGSSpanStatus)status.integerValue];
}

- (BOOL)bgsrnIsFinished {
  return _span.isFinished;
}

@end

/// One JSON value, or nil when it is missing, null, an object or an array.
static id BGSRNJSONScalar(NSString *json) {
  if (json == nil) {
    return nil;
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) {
    return nil;
  }
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data
                                              options:NSJSONReadingFragmentsAllowed
                                                error:&error];
  if (error != nil || value == nil || value == [NSNull null]) {
    return nil;
  }
  if ([value isKindOfClass:[NSDictionary class]] || [value isKindOfClass:[NSArray class]]) {
    return nil;
  }
  return value;
}

static NSString *BGSRNAttributesJSON(NSDictionary *attributes) {
  if (attributes == nil || attributes.count == 0) {
    return @"{}";
  }
  if (![NSJSONSerialization isValidJSONObject:attributes]) {
    return @"{}";
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:attributes options:0 error:nil];
  if (data == nil) {
    return @"{}";
  }
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{}";
}

static NSDictionary *BGSRNSpanSnapshot(NSString *handle, id<BGSSpan> span) {
  NSMutableDictionary *map = [NSMutableDictionary dictionary];
  map[@"handle"] = handle ?: @"";
  map[@"spanId"] = span.spanId ?: @"";
  map[@"traceId"] = span.traceId ?: @"";
  map[@"operation"] = span.operation ?: @"";
  map[@"description"] = span.spanDescription ?: [NSNull null];
  map[@"status"] = @((NSInteger)span.status);
  map[@"finished"] = @(span.isFinished);
  map[@"attributesJson"] = BGSRNAttributesJSON(span.attributes);
  if ([span conformsToProtocol:@protocol(BGSTransaction)]) {
    id<BGSTransaction> transaction = (id<BGSTransaction>)span;
    map[@"name"] = transaction.name ?: @"";
    map[@"sampled"] = @(transaction.isSampled);
  }
  return map;
}

static NSDictionary *BGSRNNoSpan(void) {
  return @{@"handle": @""};
}

@interface BugseeModule ()
@property (nonatomic, strong) BGSRNSpanHandles *spanHandles;
@end

@implementation BugseeModule {
  os_unfair_lock _spanRegistryLock;
  /// This module's claim on the secure store (`claimRuntime`).
  NSInteger _secureRuntime;
  BOOL _spansRetired;
}

@synthesize spanHandles = _spanHandles;
/// This runtime's view registry (set by React Native through
/// `RCTBridgeModuleDecorator`): how a `<Modal>` host is found by its React
/// tag without searching windows another runtime shares.
@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;

RCT_EXPORT_MODULE(Bugsee)

/// Design §6.1: this wrapper registers at module init, the iOS counterpart of
/// Android's ContentProvider. Early enough that a `startBlackout()` made
/// before `launch()` has a wrapper to deliver `BlackoutStarted` to. Not
/// `attachToBridges` — that waits until `getTurboModule:` because the codegen
/// emitter is unset before then, and this call does not emit.
- (instancetype)init {
  if ((self = [super init])) {
    _spanRegistryLock = OS_UNFAIR_LOCK_INIT;
    // A new JS runtime: Modal surfaces the previous one left behind (a reload
    // with a secure Modal open) are dropped before this one's JS can publish.
    _secureRuntime = [BGSRNSecureRectangles.shared claimRuntime];
    BGSRNSetWrapper((id<BugseeWrapper>)[BGSRNWrapper wrapperWithoutJsRuntime], YES);
    BGSRNInstallConsoleCapture();
    BGSRNInstallLogEventFilter();
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
        return BGSRNReactOriginFindingTheRoot();
      }];
  // After the emitter exists. A network filter installed earlier reads this
  // pointer when an event arrives; it is nil until then, and a nil module
  // drops the event.
  BGSRNNetworkFilterModule = self;
  // After the emitter exists. The native log filter is already installed.
  // While a user callback is on, a nil module drops the line. With no user
  // callback the same filter returns the line.
  BGSRNLogFilterModule = self;
  // Same lifetime as the log filter: nil until the emitter exists, and a nil
  // module drops the crumb.
  BGSRNBreadcrumbFilterModule = self;
}

/// Identity-checked inside the bus: a reload can construct and attach the NEW
/// module before this one is invalidated, and an unconditional clear would then
/// silence the live bridge.
- (void)invalidate {
  // No super call: `invalidate` comes from RCTInvalidating, and
  // NativeBugseeSpecBase inherits NSObject, which does not declare it.
  [BGSRNEventBus.shared detach:self];
  // This runtime's Modal surfaces cannot be cleared by its JS any more. A
  // no-op when the next module has already claimed the store.
  [BGSRNSecureRectangles.shared releaseRuntime:_secureRuntime];
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
  // Drop this module's unanswered crumbs. A reload may already have attached
  // the new module; only clear the pointer when it is still us.
  BGSRNDropBreadcrumbFiltersOwnedBy(self);
  if (BGSRNBreadcrumbFilterModule == self) {
    BGSRNBreadcrumbFilterModule = nil;
  }
  // The next runtime cannot know these handles. Drop them without finishing:
  // a reload must not close a transaction the SDK still has. The getter
  // must not allocate a fresh registry after this: a span call still in
  // flight would adopt into an object invalidate already abandoned.
  os_unfair_lock_lock(&_spanRegistryLock);
  _spansRetired = YES;
  BGSRNSpanHandles *previous = _spanHandles;
  _spanHandles = [BGSRNSpanHandles closedRegistry];
  os_unfair_lock_unlock(&_spanRegistryLock);
  [previous releaseAll];
}

/// The SDK touches UIKit during start-up, so it must not be constructed on a
/// background queue. React Native honours this for module setup; the main-queue
/// hops below cover the method calls, which it does not.
+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (void)setSecureRectangles:(double)display
                coordinates:(NSArray *)coordinates {
  [self setSecureRectanglesOnSurface:display
                             surface:BGSRNSecureMainSurface
                         coordinates:coordinates];
}

- (void)setSecureRectanglesOnSurface:(double)display
                             surface:(double)surface
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

  // Ignored once a newer runtime has claimed the store: this module's late
  // writes (a reload's teardown) must not touch the next runtime's lanes,
  // whose keys may be the same React tags.
  const NSInteger key = (NSInteger)llround(surface);
  const BOOL published = [BGSRNSecureRectangles.shared setCoordinates:flat
                                                                count:count
                                                           forDisplay:(NSInteger)display
                                                              surface:key
                                                              runtime:_secureRuntime];
  free(flat);
  // The main surface's rectangles: find the React root now, on main, and
  // record its window's place, rather than leave the lane failing closed
  // until a pull's search (`BGSRNReactRootOriginTracker`) gets to it.
  if (published && count > 0 && key == BGSRNSecureMainSurface) {
    const NSInteger target = (NSInteger)display;
    BGSRNRunOnMain(^{
      NSValue *origin = [BGSRNSecureOriginTracker() originFindingTheRoot];
      if (origin != nil) {
        [BGSRNSecureRectangles.shared setOrigin:origin.CGPointValue forDisplay:target];
      }
    });
  }
  // A <Modal>'s rectangles: name this runtime's lookup of its host, so the
  // pull places them by this runtime's Modal. An empty publish (the Modal
  // clearing on unmount) names nothing.
  if (published && count > 0 && key != BGSRNSecureMainSurface) {
    [self nameModalHostForSurface:key];
  }
}

/// Names, under this module's claim, how the store finds the `<Modal>` host
/// with React tag `surface`: this runtime's view registry, which another
/// runtime's same-tag host is not in. Not looked up here: Fabric mounts the
/// host after JS has measured and published inside it, so the pull asks (on
/// main) until the host is there, then holds it weakly; until then the lane
/// fails closed. No registry: nothing is named, and the pull falls back to a
/// unique class+tag match.
- (void)nameModalHostForSurface:(NSInteger)surface {
  __weak RCTViewRegistry *registry = self.viewRegistry_DEPRECATED;
  if (registry == nil) {
    return;
  }
  [BGSRNSecureRectangles.shared setHostResolver:^id _Nullable(NSInteger tag) {
    return [registry viewForReactTag:@(tag)];
  }
                                     forSurface:surface
                                        runtime:_secureRuntime];
}

/// The screen origin `[x, y]` (points) of the `<Modal>` whose host has React
/// tag `surface`, for the `vh` walk, which asks once per Modal per walk.
/// Empty when the Modal is not presented.
- (NSArray<NSNumber *> *)secureSurfaceOrigin:(double)surface {
  __block NSArray<NSNumber *> *origin = @[];
  const NSInteger key = (NSInteger)llround(surface);
  BGSRNRunOnMainSync(^{
    NSValue *value = BGSRNModalSurfaceOrigin(key);
    if (value != nil) {
      CGPoint p = value.CGPointValue;
      origin = @[ @(p.x), @(p.y) ];
    }
  });
  return origin;
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
    // launch can replace the log filter. Put the pass-through, or the user
    // filter if one is already on, back. This does not set the filter to nil.
    BGSRNInstallLogEventFilter();
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
                          // same queue this method hopped onto. Reinstall
                          // here: relaunch can replace the log filter.
                          dispatch_async(dispatch_get_main_queue(), ^{
                            BGSRNInstallLogEventFilter();
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
      NSLog(@"BugseeRN exception options unparseable: %@", BGSRNErrorMessage(error));
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
            BGSRNErrorMessage(error));
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
  // Keeping this channel line ends the equal-text claim. A later Custom line
  // of the same text is not dropped. One raw stdout or stderr line of this
  // text may still be, and so may a stderr stamp.
  BGSRNBeginChannelLine(message);
  @try {
    [BGSRNWrapperChannelHolder.shared logMessage:message level:(NSInteger)llround(level)];
  } @finally {
    BGSRNEndChannelLine(message);
  }
}

/// `NSNumber`, not void: codegen queues a void method on the method queue,
/// and the SDK could capture the console echo before the note existed. The
/// console hook calls this on the JS thread before it writes the line.
- (NSNumber *)noteConsoleEcho:(NSString *)message {
  BGSRNNoteConsoleEcho(message);
  return @YES;
}


/// `setNetworkEventFilter:`, the method the iOS SDK installs a network filter
/// with. `enabled` registers the bridge; `NO` passes nil, which removes it.
/// The write is synchronized and does not need the main queue, so it happens
/// before this method returns: a later Bugsee call on the same turn already
/// sees the filter. The block returns without waiting on JS. There is no
/// deadline here.
///
/// Returns `@YES`. The return is what keeps the call on the JS thread:
/// codegen queues a `void` TurboModule method onto the module queue, so a
/// request started on the next line could be recorded before a queued
/// install landed, with its url, headers and body unfiltered. The SDK setter
/// only takes a lock, so it is safe on the JS thread.
- (NSNumber *)setNetworkFilterEnabled:(BOOL)enabled {
  if (enabled) {
    @synchronized (BGSRNNetworkFilterLock()) {
      if (BGSRNNetworkFilterInstalled) {
        return @YES;
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
  return @YES;
  }
  @synchronized (BGSRNNetworkFilterLock()) {
    BGSRNNetworkFilterInstalled = NO;
  }
  [Bugsee setNetworkEventFilter:nil];
  return @YES;
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

/// Returns `@YES`. The return is what keeps the call on the JS thread:
/// codegen queues a `void` TurboModule method onto the module queue, so a
/// console line written on the next line could be captured before a queued
/// flag flip landed. The flag write and the SDK setter only take locks.
- (NSNumber *)setLogFilterEnabled:(BOOL)enabled {
  @synchronized (BGSRNLogFilterLock()) {
    BGSRNLogFilterUserEnabled = enabled;
  }
  BGSRNInstallLogEventFilter();
  return @YES;
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

/// `setBreadcrumbFilter:`. `enabled` registers the bridge; `NO` passes nil,
/// which removes it. The block returns without waiting on JS.
///
/// Returns `@YES`. The return is what keeps the call on the JS thread:
/// codegen queues a `void` TurboModule method onto the shared module queue,
/// and `addBreadcrumb` (which returns a value) runs inline. A queued clear
/// could then uninstall on main between a same-turn re-enable and the add
/// after it, and that add recorded with no filter, its original value kept.
///
/// Enable stays on the calling queue, before this method returns. Not wrapped
/// in `BGSRNRunOnMain`: an async install would let a crumb recorded on the
/// next line pass before the filter existed. Disable hops to the main queue,
/// where `addBreadcrumb` already queued its record. That queue is FIFO, so
/// the nil cannot overtake the crumb. The generation this disable captured
/// has to still be current or the nil does not run: a clear and then a new
/// callback, before main runs, must not have the queued nil remove the newer
/// filter. There is no timer that calls `decision(nil)`. A late decision
/// still records.
- (NSNumber *)setBreadcrumbFilterEnabled:(BOOL)enabled {
  if (enabled) {
    @synchronized (BGSRNBreadcrumbFilterLock()) {
      BGSRNBreadcrumbFilterGeneration += 1;
      if (BGSRNBreadcrumbFilterInstalled) {
        return @YES;
      }
      BGSRNBreadcrumbFilterInstalled = YES;
    }
    [Bugsee setBreadcrumbFilter:^(id<BGSBreadcrumb> breadcrumb, BugseeBreadcrumbFilterDecisionBlock decision) {
        if (decision == nil) {
          return;
        }
        if (breadcrumb == nil) {
          decision(nil);
          return;
        }
        BugseeModule *module = BGSRNBreadcrumbFilterModule;
        if (module == nil) {
          decision(nil);
          return;
        }
        NSString *crumbJson = BGSRNBreadcrumbSnapshotJson(breadcrumb);
        if (crumbJson == nil) {
          decision(nil);
          return;
        }
        BGSRNBreadcrumbFilterPending *item = [BGSRNBreadcrumbFilterPending new];
        item.breadcrumb = breadcrumb;
        item.decision = decision;
        item.owner = module;
        NSString *requestId = nil;
        @synchronized (BGSRNBreadcrumbFilterLock()) {
          BGSRNBreadcrumbFilterNextId += 1;
          requestId = [NSString stringWithFormat:@"%lld", BGSRNBreadcrumbFilterNextId];
          BGSRNBreadcrumbFilterPendingTable[requestId] = item;
        }
        NSString *manualAddId = nil;
        @synchronized (BGSRNBreadcrumbFilterLock()) {
          manualAddId = BGSRNBreadcrumbManualAddId;
        }
        const BOOL delivered = [module emitBreadcrumbFilterRequest:requestId
                                                          crumbJson:crumbJson
                                                              addId:manualAddId];
        if (delivered && manualAddId != nil) {
          @synchronized (BGSRNBreadcrumbFilterLock()) {
            if ([BGSRNBreadcrumbManualAddId isEqualToString:manualAddId]) {
              BGSRNBreadcrumbManualAddId = nil;
            }
          }
        }
        if (!delivered) {
          BugseeBreadcrumbFilterDecisionBlock drop = nil;
          @synchronized (BGSRNBreadcrumbFilterLock()) {
            BGSRNBreadcrumbFilterPending *removed = BGSRNBreadcrumbFilterPendingTable[requestId];
            [BGSRNBreadcrumbFilterPendingTable removeObjectForKey:requestId];
            drop = removed.decision;
          }
          if (drop != nil) {
            drop(nil);
          }
        }
      }];
    return @YES;
  }
  int64_t generation = 0;
  @synchronized (BGSRNBreadcrumbFilterLock()) {
    BGSRNBreadcrumbFilterGeneration += 1;
    generation = BGSRNBreadcrumbFilterGeneration;
  }
  BGSRNRunOnMain(^{
    @synchronized (BGSRNBreadcrumbFilterLock()) {
      if (BGSRNBreadcrumbFilterGeneration != generation) {
        return;
      }
      BGSRNBreadcrumbFilterInstalled = NO;
      [Bugsee setBreadcrumbFilter:nil];
    }
  });
  return @YES;
}

- (BOOL)emitBreadcrumbFilterRequest:(NSString *)requestId
                           crumbJson:(NSString *)crumbJson
                               addId:(NSString * _Nullable)addId {
  NSDictionary *payload = addId != nil
      ? @{ @"requestId" : requestId, @"crumbJson" : crumbJson, @"addId" : addId }
      : @{ @"requestId" : requestId, @"crumbJson" : crumbJson };
  return BGSRNGuardedEmit(^{
    [self emitOnBreadcrumbFilterRequest:payload];
  }, @"onBreadcrumbFilterRequest");
}

/// The main-queue record dropped this id (no factory, no crumb, or the filter
/// never asked). JS drops the owed callback. `crumbJson` is empty, so the
/// callback does not run. The request id is not in the pending table, so the
/// reply is a no-op. There is no timer.
- (void)releaseBreadcrumbManualAdd:(NSString *)addId {
  if (addId.length == 0) {
    return;
  }
  [self emitBreadcrumbFilterRequest:@"release" crumbJson:@"" addId:addId];
}

/// `crumbJson` nil drops. An object is written onto the same breadcrumb.
/// `timestamp` is not written: `BGSEvent.timestamp` is read-only, and the SDK
/// pins the time it observed before the filter ran. If a write does not
/// stick, the crumb is dropped rather than kept unredacted. A second reply
/// is a no-op. There is no timer.
- (void)replyBreadcrumbFilter:(NSString *)requestId crumbJson:(NSString * _Nullable)crumbJson {
  if (requestId == nil) {
    return;
  }
  BGSRNBreadcrumbFilterPending *item = nil;
  @synchronized (BGSRNBreadcrumbFilterLock()) {
    item = BGSRNBreadcrumbFilterPendingTable[requestId];
    if (item != nil) {
      [BGSRNBreadcrumbFilterPendingTable removeObjectForKey:requestId];
    }
  }
  if (item.decision == nil) {
    return;
  }
  if (crumbJson == nil) {
    item.decision(nil);
    return;
  }
  NSError *error = nil;
  NSDictionary *kept = BGSRNJSONObject(crumbJson, &error);
  if (kept == nil || !BGSRNApplyBreadcrumbKeep(item.breadcrumb, kept)) {
    item.decision(nil);
    return;
  }
  item.decision(item.breadcrumb);
}

/// The no-argument `createBreadcrumb` leaves the timestamp unset so the
/// provider stamps it. `level` is the JS name, mapped to `BugseeLogLevel`.
/// `dataJson` nil leaves data unset. The record itself is on main, like
/// every other SDK entry point. Capture being off is decided here, on the
/// calling queue, so this can return false without queueing. The filter
/// install above is also on the calling queue. A filter clear is on the
/// main queue, behind the block queued here.
///
/// Returns true only when a filter request for `addId` was emitted or will
/// be emitted. A drop on main (no factory, no crumb, or the filter never
/// asked) releases that id so JS does not leave it owed. `addId` is echoed
/// only for the duration of `[Bugsee addBreadcrumb:]`.
- (NSNumber *)addBreadcrumb:(NSString *)category
                      level:(NSString *)level
                    message:(NSString *)message
                       type:(NSString *)type
                   dataJson:(NSString * _Nullable)dataJson
                      addId:(NSString * _Nullable)addId {
  NSDictionary *data = nil;
  const BOOL hasData = dataJson != nil;
  if (hasData) {
    NSError *error = nil;
    data = BGSRNJSONObject(dataJson, &error);
    if (data == nil) {
      NSLog(@"BugseeRN addBreadcrumb dropped: its data is not a JSON object: %@",
            BGSRNErrorMessage(error));
      return @NO;
    }
  }
  NSInteger levelValue = 0;
  if (![level isKindOfClass:NSString.class]
      || !BGSRNBreadcrumbLevelFromName(level, &levelValue)) {
    NSLog(@"BugseeRN addBreadcrumb dropped: level is not a breadcrumb level name");
    return @NO;
  }
  // createBreadcrumb still returns a crumb when capture is left off, and
  // addBreadcrumb: then records nothing. The option is the signal, and it
  // is read here so a false return does not queue a record.
  id capture = [Bugsee getLaunchOptions][BugseeOptionCaptureBreadcrumbs];
  if (![capture isKindOfClass:NSNumber.class] || ![(NSNumber *)capture boolValue]) {
    NSLog(@"BugseeRN addBreadcrumb dropped: capture is off or the SDK made no crumb");
    return @NO;
  }
  __weak BugseeModule *module = self;
  BGSRNRunOnMain(^{
    BugseeModule *strong = module;
    id<BGSBugseeExchangeFactory> factory = [Bugsee getExchangeFactory];
    id<BGSBreadcrumb> crumb = factory != nil ? [factory createBreadcrumb] : nil;
    if (crumb == nil) {
      NSLog(@"BugseeRN addBreadcrumb dropped: capture is off or the SDK made no crumb");
      [strong releaseBreadcrumbManualAdd:addId];
      return;
    }
    crumb.category = category;
    crumb.level = levelValue;
    crumb.message = message;
    crumb.type = type;
    if (hasData) {
      crumb.data = data;
    }
    @synchronized (BGSRNBreadcrumbFilterLock()) {
      BGSRNBreadcrumbManualAddId = addId;
    }
    @try {
      [Bugsee addBreadcrumb:crumb];
    } @finally {
      NSString *leftover = nil;
      @synchronized (BGSRNBreadcrumbFilterLock()) {
        leftover = BGSRNBreadcrumbManualAddId;
        BGSRNBreadcrumbManualAddId = nil;
      }
      if (leftover != nil) {
        [strong releaseBreadcrumbManualAdd:leftover];
      }
    }
  });
  return addId != nil ? @YES : @NO;
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
    BGSRNRejectException(reject, @"reportRead", exception);
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
      reject(BGSRNReportErrorWireCode(error), BGSRNErrorMessage(error), nil);
    }
  } @catch (NSException *exception) {
    BGSRNRejectException(reject, @"reportUpdate", exception);
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
    BGSRNRejectException(reject, @"reportAddFileAttachment", exception);
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
    BGSRNRejectException(reject, @"reportAddDataAttachment", exception);
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
      BGSRNRejectException(reject, @"createReport", exception);
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
      BGSRNRejectException(reject, @"createdReportRead", exception);
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
        reject(BGSRNReportErrorWireCode(error), BGSRNErrorMessage(error), nil);
      }
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, @"createdReportUpdate", exception);
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
        reject(BGSRNReportErrorWireCode(error), BGSRNErrorMessage(error), nil);
      }
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, @"createdReportAddDataAttachment", exception);
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
        reject(BGSRNReportErrorWireCode(error), BGSRNErrorMessage(error), nil);
      }
    } @catch (NSException *exception) {
      BGSRNRejectException(reject, @"createdReportAddFileAttachment", exception);
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
      BGSRNRejectException(reject, @"createdReportUpload", exception);
    }
  });
}

- (BGSRNSpanHandles *)spanHandles {
  os_unfair_lock_lock(&_spanRegistryLock);
  BGSRNSpanHandles *handles = _spansRetired ? [BGSRNSpanHandles closedRegistry] : _spanHandles;
  if (handles == nil) {
    handles = [BGSRNSpanHandles new];
    _spanHandles = handles;
  }
  os_unfair_lock_unlock(&_spanRegistryLock);
  return handles;
}

- (BGSRNLiveSpan *)liveSpan:(NSString *)handle {
  id adapter = [self.spanHandles adapterForHandle:handle];
  return [adapter isKindOfClass:[BGSRNLiveSpan class]] ? adapter : nil;
}

- (NSDictionary *)adoptSpan:(id<BGSSpan>)span {
  if (span == nil) {
    return BGSRNNoSpan();
  }
  BGSRNLiveSpan *adapter = [[BGSRNLiveSpan alloc] initWithSpan:span];
  NSString *handle = [self.spanHandles retainSpan:span adapter:adapter];
  return BGSRNSpanSnapshot(handle, span);
}

/// On main, synchronously. The active span is pthread-local and does not
/// cross dispatch_async, and every span call has to see the same thread.
- (void)notify:(NSString *)title
          body:(NSString *)body
      severity:(double)severity
    fieldsJson:(NSString *)fieldsJson
        urgent:(BOOL)urgent {
  NSDictionary *parsed = nil;
  if (fieldsJson != nil) {
    NSError *error = nil;
    parsed = BGSRNJSONObject(fieldsJson, &error);
    if (parsed == nil) {
      NSLog(@"BugseeRN notify dropped: %@", BGSRNErrorMessage(error));
      return;
    }
  }
  NSMutableDictionary<NSString *, NSString *> *fields = nil;
  if (parsed != nil) {
    fields = [NSMutableDictionary dictionary];
    for (NSString *key in parsed) {
      id value = parsed[key];
      if ([value isKindOfClass:[NSString class]]) {
        fields[key] = value;
      }
    }
  }
  NSInteger wire = (NSInteger)llround(severity);
  BGSRNRunOnMain(^{
    [Bugsee notifyWithTitle:title
                       body:body
                   severity:(BugseeSeverityLevel)wire
                     fields:fields
                     urgent:urgent];
  });
}

- (NSDictionary *)startTransaction:(NSString *)name
                         operation:(NSString *)operation
                    attributesJson:(NSString *)attributesJson {
  __block NSDictionary *snapshot = nil;
  BGSRNRunOnMainSync(^{
    NSDictionary *attributes = nil;
    if (attributesJson != nil) {
      NSError *error = nil;
      attributes = BGSRNJSONObject(attributesJson, &error);
      if (attributes == nil) {
        NSLog(@"BugseeRN startTransaction dropped attributes: %@", BGSRNErrorMessage(error));
      }
    }
    id<BGSTransaction> transaction = attributes == nil
        ? [Bugsee startTransactionWithName:name operation:operation]
        : [Bugsee startTransactionWithName:name operation:operation attributes:attributes];
    snapshot = [self adoptSpan:transaction];
  });
  return snapshot;
}

- (NSDictionary *)startSpan:(NSString *)operation description:(NSString *)description {
  __block NSDictionary *snapshot = nil;
  BGSRNRunOnMainSync(^{
    snapshot = [self adoptSpan:[Bugsee startSpanWithOperation:operation description:description]];
  });
  return snapshot;
}

- (NSDictionary *)getActiveSpan {
  __block NSDictionary *snapshot = nil;
  BGSRNRunOnMainSync(^{
    snapshot = [self adoptSpan:[Bugsee getActiveSpan]];
  });
  return snapshot;
}

/// `NSNumber`, not void: codegen queues a void method, so a setter then
/// `spanFinish` in one turn would release the handle before the setter ran.
/// The hop stays synchronous so the active span's thread is still main.
/// Codegen's boolean is `NSNumber *`, the same as `addBreadcrumb`.
- (NSNumber *)spanSetName:(NSString *)handle name:(NSString *)name {
  __block BOOL applied = NO;
  BGSRNRunOnMainSync(^{
    BGSRNLiveSpan *live = [self liveSpan:handle];
    if (live == nil) {
      return;
    }
    [live.span setName:name];
    applied = YES;
  });
  return @(applied);
}

- (NSNumber *)spanSetDescription:(NSString *)handle description:(NSString *)description {
  __block BOOL applied = NO;
  BGSRNRunOnMainSync(^{
    BGSRNLiveSpan *live = [self liveSpan:handle];
    if (live == nil) {
      return;
    }
    [live.span setSpanDescription:description];
    applied = YES;
  });
  return @(applied);
}

- (NSNumber *)spanSetAttribute:(NSString *)handle key:(NSString *)key valueJson:(NSString *)valueJson {
  __block BOOL applied = NO;
  BGSRNRunOnMainSync(^{
    id value = BGSRNJSONScalar(valueJson);
    if (value == nil) {
      NSLog(@"BugseeRN span attribute dropped: value is not a string, number or boolean");
      return;
    }
    BGSRNLiveSpan *live = [self liveSpan:handle];
    if (live == nil) {
      return;
    }
    [live.span setAttribute:key value:value];
    applied = YES;
  });
  return @(applied);
}

- (NSNumber *)spanSetStatus:(NSString *)handle status:(double)status {
  __block BOOL applied = NO;
  BGSRNRunOnMainSync(^{
    NSInteger wire = (NSInteger)llround(status);
    if (wire < BGSSpanStatusOK || wire > BGSSpanStatusUnknown) {
      NSLog(@"BugseeRN span status is outside 0..5");
      return;
    }
    BGSRNLiveSpan *live = [self liveSpan:handle];
    if (live == nil) {
      return;
    }
    [live.span setStatus:(BGSSpanStatus)wire];
    applied = YES;
  });
  return @(applied);
}

- (NSDictionary *)spanStartChild:(NSString *)handle
                       operation:(NSString *)operation
                     description:(NSString *)description {
  __block NSDictionary *snapshot = nil;
  BGSRNRunOnMainSync(^{
    BGSRNLiveSpan *live = [self liveSpan:handle];
    if (live == nil) {
      snapshot = BGSRNNoSpan();
      return;
    }
    id<BGSSpan> child = description == nil
        ? [live.span startChildSpanWithOperation:operation]
        : [live.span startChildSpanWithOperation:operation description:description];
    snapshot = [self adoptSpan:child];
  });
  return snapshot;
}

- (NSArray<NSString *> *)spanFinish:(NSString *)handle
                             status:(double)status
                        statusSet:(BOOL)statusSet {
  __block NSArray<NSString *> *released = @[];
  BGSRNRunOnMainSync(^{
    NSNumber *wire = nil;
    if (statusSet) {
      NSInteger value = (NSInteger)llround(status);
      if (value < BGSSpanStatusOK || value > BGSSpanStatusUnknown) {
        NSLog(@"BugseeRN span finish status is outside 0..5");
        return;
      }
      wire = @(value);
    }
    released = [self.spanHandles finishHandle:handle status:wire];
  });
  return released;
}

/// Writable report colors on BugseeTheme (7.0.0-beta4; unchanged from beta3). Feedback properties
/// and the readonly palette are not report appearance. KVC with any other
/// name throws NSUnknownKeyException.
static NSSet<NSString *> *BGSRNReportColorKeys(void) {
  static NSSet<NSString *> *keys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    keys = [NSSet setWithArray:@[
      @"reportBackgroundColor",
      @"reportCellBackgroundColor",
      @"reportCloseButtonColor",
      @"reportNavigationBarColor",
      @"reportPlaceholderColor",
      @"reportSendButtonColor",
      @"reportTextColor",
      @"reportVersionColor",
    ]];
  });
  return keys;
}

static BOOL BGSRNColorComponentOK(double value) {
  return value >= 0.0 && value <= 255.0 && value == floor(value);
}

static NSString *BGSRNHexFromColor(UIColor *color) {
  if (![color isKindOfClass:[UIColor class]]) {
    return @"";
  }
  CGFloat r = 0, g = 0, b = 0, a = 0;
  if (![color getRed:&r green:&g blue:&b alpha:&a]) {
    return @"";
  }
  int ri = (int)llround(r * 255.0);
  int gi = (int)llround(g * 255.0);
  int bi = (int)llround(b * 255.0);
  int ai = (int)llround(a * 255.0);
  ri = MAX(0, MIN(255, ri));
  gi = MAX(0, MIN(255, gi));
  bi = MAX(0, MIN(255, bi));
  ai = MAX(0, MIN(255, ai));
  return [NSString stringWithFormat:@"#%02x%02x%02x%02x", ri, gi, bi, ai];
}

- (NSNumber *)setAppearanceColor:(NSString *)name
                               r:(double)r
                               g:(double)g
                               b:(double)b
                               a:(double)a {
  if (![BGSRNReportColorKeys() containsObject:name]) {
    return @NO;
  }
  if (!BGSRNColorComponentOK(r) || !BGSRNColorComponentOK(g) ||
      !BGSRNColorComponentOK(b) || !BGSRNColorComponentOK(a)) {
    return @NO;
  }
  UIColor *color = [UIColor colorWithRed:(CGFloat)(r / 255.0)
                                    green:(CGFloat)(g / 255.0)
                                     blue:(CGFloat)(b / 255.0)
                                    alpha:(CGFloat)(a / 255.0)];
  __block BOOL applied = NO;
  BGSRNRunOnMainSync(^{
    [[Bugsee getAppearance] setValue:color forKey:name];
    applied = YES;
  });
  return @(applied);
}

- (NSString *)getAppearanceColor:(NSString *)name {
  if (![BGSRNReportColorKeys() containsObject:name]) {
    return @"";
  }
  __block NSString *hex = @"";
  BGSRNRunOnMainSync(^{
    id value = [[Bugsee getAppearance] valueForKey:name];
    hex = BGSRNHexFromColor(value);
  });
  return hex;
}

/// iOS 7.0.0-beta3 and beta4 return without invoking `completion` when the SDK is
/// not stopped, so a launched call resolves `false` immediately. That is the
/// missing completion, not a wait. Stopped, including a nil instance, still
/// calls the SDK method and settles through `BGSRNSettleOnce`: the
/// completion's success, or `false` if the deadline fires first. Status and
/// both SDK calls run on the main queue. A completion that arrives off main
/// hops back before it writes the result the settler resolves.
- (void)deleteCollectedDataOnDevice:(BOOL)includingIntermediate
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  BGSRNRunOnMain(^{
    Bugsee *instance = [Bugsee sharedInstance];
    BugseeStatus status = instance != nil ? instance.status : BugseeStatusStopped;
    if (status != BugseeStatusStopped) {
      __block BOOL settled = NO;
      [Bugsee deleteCollectedDataOnDevice:includingIntermediate completion:^(BOOL success) {
        BGSRNRunOnMain(^{
          if (settled) {
            return;
          }
          settled = YES;
          resolve(@(success));
        });
      }];
      if (!settled) {
        settled = YES;
        resolve(@NO);
      }
      return;
    }
    __block NSNumber *result = @NO;
    dispatch_block_t done =
        BGSRNSettleOnce(BGSRNUnhandledCompletionDeadlineMs, dispatch_get_main_queue(), ^{
          resolve(result);
        });
    [Bugsee deleteCollectedDataOnDevice:includingIntermediate completion:^(BOOL success) {
      BGSRNRunOnMain(^{
        result = @(success);
        done();
      });
    }];
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
