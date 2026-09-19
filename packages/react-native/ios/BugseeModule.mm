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
#import <BugseeRNSupport/BGSRNStatusMapper.h>
#import <BugseeRNSupport/BGSRNTokens.h>
#else
#import "BGSRNMainThread.h"
#import "BGSRNWrapper.h"
#import "BGSRNStatusMapper.h"
#import "BGSRNTokens.h"
#endif

/// The conformance lives here rather than in the Support package so that the
/// package stays buildable and testable without the SDK's headers. BGSRNWrapper
/// already declares every property the protocol requires; this states that it
/// satisfies the contract.
@interface BGSRNWrapper (BugseeConformance) <BugseeWrapper>
@end

@implementation BGSRNWrapper (BugseeConformance)

- (void)onLifecycleEvent:(NSString *)eventType data:(id)data {
}

/// The packed buffer the SDK expects: `[version, count, l,t,r,b, ...]` as
/// little-endian int32. Nothing is redacted yet — Task 3.3 wires real
/// rectangles — so this publishes an empty set, which a count of 0 means.
///
/// The version is held constant BECAUSE the set never changes. Changing it
/// per call would make the SDK re-read an identical set on every frame; the
/// header's rule is that any two DIFFERENT sets carry different versions.
///
/// An immutable NSData built here, not a reused buffer: the header warns that
/// a mutable buffer rewritten from another thread is a use-after-free while
/// the SDK reads it, and a React Native wrapper's state lives on the JS
/// thread.
- (NSData *)secureRectanglesForDisplay:(NSInteger)display {
  const int32_t header[2] = { 1, 0 };
  return [NSData dataWithBytes:header length:sizeof(header)];
}

- (void)requestDataWithType:(NSString *)dataType
                   callback:(id<BGSDataRequestResultCallback>)callback {
  // Always answer: the SDK waits on this mid-capture.
  [callback onResult:nil];
}

- (void)onBeforeReportCreated:(id<BGSReportContract>)report
                isTerminating:(BOOL)isTerminating
                   completion:(BGSCallback)completion {
  if (completion) {
    completion();
  }
}

- (void)onAfterReportCreated:(id<BGSReportContract>)report
               isTerminating:(BOOL)isTerminating
                  completion:(BGSCallback)completion {
  if (completion) {
    completion();
  }
}

@end

@implementation BugseeModule

RCT_EXPORT_MODULE(Bugsee)

/// The SDK touches UIKit during start-up, so it must not be constructed on a
/// background queue. React Native honours this for module setup; the main-queue
/// hops below cover the method calls, which it does not.
+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (void)setWrapperInfo:(NSDictionary *)identity {
  BGSRNRunOnMain(^{
    // The SDK holds the wrapper for the process's lifetime and reads it while
    // composing a report's environment, so this must be registered before
    // launch rather than alongside it.
    [Bugsee setWrapper:(id<BugseeWrapper>)[BGSRNWrapper wrapperWithIdentity:identity]];
  });
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
    //
    // The timeout is not defensive decoration. relaunchWithOptions:started:
    // reaches its completion through [Bugsee stop:], whose own completion runs
    // inside -stopRecording:. When the preceding launch never brought capture
    // up — an invalid app token does this — that callback does not arrive, and
    // started: is never invoked. Reproduced on a simulator: `relaunch()` never
    // settles, and a promise that never settles is indistinguishable from a
    // slow one.
    //
    // TEMPORARY, tracked by bugsee/bugsee-cocoa#99: once started: is
    // guaranteed to fire exactly once on every path, delete `settled`, the
    // dispatch_after and the E_RELAUNCH_NO_REPORT rejection, and resolve
    // straight from the callback. Until then a wrapper must not hand JS a
    // promise that can hang forever.
    // `settled` is guarded by the main queue, not by luck: every writer below
    // runs there. The SDK invokes started: on whatever thread its stop
    // completion happens to use, so without the hop that callback and the
    // timeout could both observe NO and settle the same promise twice --
    // resolve and reject, on one promise.
    __block BOOL settled = NO;
    void (^settleOnce)(BOOL, BOOL) = ^(BOOL known, BOOL success) {
      NSCAssert([NSThread isMainThread], @"settleOnce must run on the main queue");
      if (settled) {
        return;
      }
      settled = YES;
      if (known) {
        resolve(@(success));
      } else {
        reject(@"E_RELAUNCH_NO_REPORT",
               @"Bugsee.relaunch did not report completion within 30s. The SDK "
               @"may or may not have restarted; call getStatus() to find out.",
               nil);
      }
    };

    [Bugsee relaunchWithOptions:[BugseeOptions optionsFrom:options]
                        started:^(BOOL success) {
                          // Onto the main queue so this writer and the timeout
                          // below are serialised on one queue.
                          dispatch_async(dispatch_get_main_queue(), ^{
                            settleOnce(YES, success);
                          });
                        }];

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          settleOnce(NO, NO);
        });
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
    // NOTE, tracked by bugsee/bugsee-cocoa#100: iOS returns only the options
    // that DIFFER from its defaults (+getLaunchOptions is [options
    // userOptions]), so unlike Android this cannot answer a getter the app
    // never set. BugseeOptions -dictionary holds the resolved set and is
    // public, but nothing public hands out the live options object. When the
    // SDK exposes the effective set, this returns it and the platform caveats
    // in NativeBugsee.ts, index.ts and BugseeLaunchOptions.refreshFrom go
    // away with it.
    resolve([Bugsee getLaunchOptions] ?: @{});
  });
}

- (void)testCrash {
  BGSRNRunOnMain(^{
    [Bugsee testCrash];
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBugseeSpecJSI>(params);
}

@end
