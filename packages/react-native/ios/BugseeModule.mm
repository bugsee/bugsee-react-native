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
#import <BugseeRNSupport/BGSRNStatusMapper.h>
#import <BugseeRNSupport/BGSRNTokens.h>
#else
#import "BGSRNStatusMapper.h"
#import "BGSRNTokens.h"
#endif

@implementation BugseeModule

RCT_EXPORT_MODULE(Bugsee)

/// The SDK touches UIKit during start-up, so it must not be constructed on a
/// background queue. React Native honours this for module setup; the main-queue
/// hops below cover the method calls, which it does not.
+ (BOOL)requiresMainQueueSetup {
  return YES;
}

/// Runs `block` on the main thread, without deadlocking if already there.
/// dispatch_sync onto the main queue from the main thread is a hard deadlock,
/// and RN does sometimes invoke a TurboModule method on the main thread.
static void BGSRunOnMain(dispatch_block_t block) {
  if ([NSThread isMainThread]) {
    block();
  } else {
    dispatch_async(dispatch_get_main_queue(), block);
  }
}

- (void)launch:(NSString *)token
       options:(NSDictionary *)options
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  if (!BGSRNTokenIsUsable(token)) {
    reject(@"E_TOKEN", @"Bugsee.launch requires a non-empty app token", nil);
    return;
  }
  BGSRunOnMain(^{
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
  BGSRunOnMain(^{
    [Bugsee relaunchWithDictionaryOptions:options];
    resolve(@YES);
  });
}

- (void)stop:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject {
  BGSRunOnMain(^{
    [Bugsee stop:^{
      resolve(@YES);
    }];
  });
}

- (void)getStatus:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  BGSRunOnMain(^{
    Bugsee *instance = [Bugsee sharedInstance];
    // No instance means the SDK was never launched, which is Stopped.
    BugseeStatus status = instance ? instance.status : BugseeStatusStopped;
    resolve(@(BGSRNStatusToWire(status)));
  });
}

- (void)testCrash {
  BGSRunOnMain(^{
    [Bugsee testCrash];
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBugseeSpecJSI>(params);
}

@end
