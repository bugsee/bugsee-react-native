#import "BugseeModule.h"

// Header imports, not `@import`. This file is ObjC++, and neither delivery path
// turns on C++ modules — CocoaPods sets CLANG_ENABLE_MODULES for ObjC only, and
// the SPM target does not pass -fcxx-modules either. A module import here fails
// with "use of '@import' when C++ modules are disabled", and then with a
// cascade of undeclared identifiers that hides the real cause.
#import <Bugsee/Bugsee.h>

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

- (void)requestDataWithType:(NSString *)dataType
                   callback:(id<BGSDataRequestResultCallback>)callback {
  // Always answer: the SDK waits on this mid-capture.
  [callback onResult:nil];
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
/// the lock: every call goes through `BGSRNRunOnMain`, so another call site
/// needs no lock of its own as long as it comes through here.
static void BGSRNSetWrapper(id<BugseeWrapper> _Nullable wrapper) {
  BGSRNRunOnMain(^{
    [Bugsee setWrapper:wrapper];
    if (wrapper == nil) {
      BGSRNWrapperChannelHolder.shared.channel = nil;
    }
  });
}

static NSString *const kHandleDeadCode = @"E_REPORT_HANDLE_DEAD";

static void BGSRNRejectHandleDead(RCTPromiseRejectBlock reject) {
  reject(kHandleDeadCode,
         @"This BugseeReport handle is no longer valid: its handler has "
         @"already settled, or its deadline has passed.",
         nil);
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

@implementation BugseeModule

RCT_EXPORT_MODULE(Bugsee)

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

- (void)setWrapperInfo:(NSDictionary *)identity {
  // The SDK holds the wrapper for the process's lifetime and reads it while
  // composing a report's environment, so this must be registered before
  // launch rather than alongside it. Through BGSRNSetWrapper, the one route
  // to `+setWrapper:` in this module.
  BGSRNSetWrapper((id<BugseeWrapper>)[BGSRNWrapper wrapperWithIdentity:identity]);
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
    resolve([Bugsee getLaunchOptions] ?: @{});
  });
}

- (void)testCrash {
  BGSRNRunOnMain(^{
    [Bugsee testCrash];
  });
}

/// The two-argument form only -- severity and labels are Phase 8. JS has
/// already checked both arguments are strings. On main, like every other SDK
/// entry point; the report it creates is a LIVE one, so its handlers run on
/// main too, after this returns.
- (void)upload:(NSString *)summary
    description:(NSString *)description {
  BGSRNRunOnMain(^{
    [Bugsee uploadWithSummary:summary description:description];
  });
}

/// Records a named event, with optional params.
///
/// `params` is `nil` exactly when JS sent `null` (no params given) rather
/// than `{}` -- the bundle's event entry has no `params` key at all when none
/// were given (design doc, Phase 4 bundle facts). JS has already validated
/// params against the accepted value domain and copied it
/// (`src/data/validate.ts`), so nothing here is re-checked. On main, like
/// every other SDK entry point.
- (void)event:(NSString *)name
       params:(NSDictionary * _Nullable)params {
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
  [BGSRNWrapperChannelHolder.shared logMessage:message level:(NSInteger)llround(level)];
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

- (void)reportUpdate:(NSString *)handleId
               patch:(NSDictionary *)patch
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  id<BGSReportContract> report = [BGSRNReportHandlerBridge.shared reportFor:handleId];
  if (report == nil) {
    BGSRNRejectHandleDead(reject);
    return;
  }
  @try {
    NSError *error = nil;
    if ([BGSRNReportOps applyPatch:patch toReport:report error:&error]) {
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

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  auto module = std::make_shared<facebook::react::NativeBugseeSpecJSI>(params);
  // Only now is the codegen event emitter set: see attachToBridges.
  [self attachToBridges];
  return module;
}

@end
