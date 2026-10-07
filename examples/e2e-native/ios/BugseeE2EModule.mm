#import "BugseeE2EModule.h"

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

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBugseeE2ESpecJSI>(params);
}

@end
