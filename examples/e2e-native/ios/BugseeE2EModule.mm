#import "BugseeE2EModule.h"

#import <React/RCTLog.h>
#import <os/log.h>

/// Where `nativeLog` lines go: subsystem com.bugsee.e2e, category native.
static os_log_t BGSE2ENativeLog(void) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("com.bugsee.e2e", "native");
  });
  return log;
}

/// A plain name: no separator, so it cannot leave the temporary directory.
/// The JS rule, again (src/index.ts).
static BOOL BGSE2EIsPlainName(NSString *name) {
  static NSRegularExpression *pattern;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    pattern = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9_.-]{1,64}$"
                                                        options:0
                                                          error:nil];
  });
  if (![name isKindOfClass:[NSString class]]) {
    return NO;
  }
  NSRange whole = NSMakeRange(0, name.length);
  if ([pattern numberOfMatchesInString:name options:0 range:whole] != 1) {
    return NO;
  }
  NSString *dots = [name stringByTrimmingCharactersInSet:
                             [NSCharacterSet characterSetWithCharactersInString:@"."]];
  return dots.length > 0;
}

@implementation BugseeE2EModule

RCT_EXPORT_MODULE(BugseeE2E)

/// A real signal crash, as Android's JNI one: `segv` stores through a bad
/// pointer (EXC_BAD_ACCESS, SIGSEGV), `abort` calls abort() (SIGABRT). Not an
/// NSException -- that is `Bugsee.testNativeCrash()` -- so the crash reporter
/// sees a signal with no Objective-C exception behind it. Any other kind is
/// logged and ignored (JS refuses it before it crosses).
- (void)crashNative:(NSString *)kind {
  if ([kind isEqualToString:@"segv"]) {
    NSLog(@"BugseeE2E: crashNative segv");
    // A low, never-mapped address; volatile so the store is not elided.
    volatile int *bad = (volatile int *)(uintptr_t)0x10;
    *bad = 1;
    return;
  }
  if ([kind isEqualToString:@"abort"]) {
    NSLog(@"BugseeE2E: crashNative abort");
    abort();
  }
  NSLog(@"BugseeE2E: crashNative: unknown kind ignored");
}

/// UTF-8 into NSTemporaryDirectory(), replacing any file there. No SDK call,
/// so no main-thread hop. No message echoes the caller's name or contents.
- (void)writeTempFile:(NSString *)name
             contents:(NSString *)contents
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  if (!BGSE2EIsPlainName(name) || ![contents isKindOfClass:[NSString class]]) {
    reject(@"E_BAD_ARGUMENT", @"writeTempFile: invalid name or contents", nil);
    return;
  }
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:name];
  NSError *error = nil;
  if (![contents writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    NSLog(@"BugseeE2E: writeTempFile failed: %@ %ld", error.domain, (long)error.code);
    reject(@"E_WRITE_FAILED", @"writeTempFile: the file could not be written", error);
    return;
  }
  resolve(path);
}

- (void)fileExists:(NSString *)path
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  BOOL directory = NO;
  BOOL exists = [path isKindOfClass:[NSString class]] &&
                [[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&directory];
  resolve(@(exists && !directory));
}

/// Blocks the main thread for `ms` from a block dispatched to it, then
/// resolves (campaign N-12: hang detection).
- (void)blockMain:(double)ms
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  if (ms < 0 || ms > 60000) {
    reject(@"E_BAD_ARGUMENT", @"blockMain: ms out of range", nil);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSDate *start = [NSDate date];
    NSLog(@"BugseeE2E: blockMain begin ms=%ld", (long)ms);
    [NSThread sleepForTimeInterval:ms / 1000.0];
    NSLog(@"BugseeE2E: blockMain end elapsed=%ld",
          (long)([[NSDate date] timeIntervalSinceDate:start] * 1000.0));
    resolve(nil);
  });
}

/// One line through os_log (subsystem com.bugsee.e2e, category native).
- (void)nativeLog:(NSString *)level message:(NSString *)message {
  if (![message isKindOfClass:[NSString class]]) {
    return;
  }
  os_log_type_t type;
  if ([level isEqualToString:@"debug"]) {
    type = OS_LOG_TYPE_DEBUG;
  } else if ([level isEqualToString:@"info"]) {
    type = OS_LOG_TYPE_INFO;
  } else if ([level isEqualToString:@"warn"]) {
    type = OS_LOG_TYPE_DEFAULT;
  } else if ([level isEqualToString:@"error"]) {
    type = OS_LOG_TYPE_ERROR;
  } else {
    NSLog(@"BugseeE2E: nativeLog: unknown level ignored");
    return;
  }
  os_log_with_type(BGSE2ENativeLog(), type, "%{public}s", message.UTF8String);
}

/// One line through React Native's RCTLog, from native code: no JS echo.
- (void)rctLog:(NSString *)level message:(NSString *)message {
  if (![message isKindOfClass:[NSString class]]) {
    return;
  }
  RCTLogLevel rct;
  if ([level isEqualToString:@"trace"]) {
    rct = RCTLogLevelTrace;
  } else if ([level isEqualToString:@"info"]) {
    rct = RCTLogLevelInfo;
  } else if ([level isEqualToString:@"warn"]) {
    rct = RCTLogLevelWarning;
  } else if ([level isEqualToString:@"error"]) {
    rct = RCTLogLevelError;
  } else {
    NSLog(@"BugseeE2E: rctLog: unknown level ignored");
    return;
  }
  _RCTLogNativeInternal(rct, __FILE__, __LINE__, @"%@", message);
}

/// iOS has no FLAG_SECURE: resolves false, and changes nothing.
- (void)setFlagSecure:(BOOL)on
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  resolve(@NO);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBugseeE2ESpecJSI>(params);
}

@end
