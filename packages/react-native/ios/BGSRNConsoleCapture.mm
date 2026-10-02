#import "BGSRNConsoleCapture.h"

#import <Bugsee/Bugsee.h>
#import <React/RCTLog.h>

#if __has_include(<BugseeRNSupport/BGSRNWrapperChannelHolder.h>)
#import <BugseeRNSupport/BGSRNWrapperChannelHolder.h>
#else
#import "BGSRNWrapperChannelHolder.h"
#endif

static NSString *const BGSRNConsoleCaptureKey = @"bugsee.rn.consoleCapture";

/**
 * RCTLog's levels are not Bugsee's. trace → Debug (4), info → Info (3),
 * warn → Warning (2), error and fatal → Error (1). The JS patch's own
 * table (error 1, warn 2, log/info 3, debug 4) is unchanged; this is only
 * the native stream.
 */
static NSInteger BGSRNWireLevelForRCTLogLevel(RCTLogLevel level) {
  switch (level) {
    case RCTLogLevelTrace:
      return 4;
    case RCTLogLevelInfo:
      return 3;
    case RCTLogLevelWarning:
      return 2;
    case RCTLogLevelError:
    case RCTLogLevelFatal:
      return 1;
    default:
      return 3;
  }
}

/// Explicit false turns console capture off. Absent means on, the SDK default.
static BOOL BGSRNConsoleCaptureEnabled(void) {
  NSDictionary *options = [Bugsee getLaunchOptions];
  id value = options[@"com.bugsee.option.capture.logs"];
  if (![value isKindOfClass:[NSNumber class]]) {
    return YES;
  }
  return [value boolValue];
}

static void BGSRNOnRCTLog(RCTLogLevel level, RCTLogSource source, NSString *message) {
  // JavaScript source is the console echo. The JS patch forwards that call
  // in dev and in release; recording it here would run the filter twice.
  // Release builds often never produce this source for console.*, and
  // dropping the patch instead of this echo would drop those logs.
  if (source == RCTLogSourceJavaScript) {
    return;
  }
  if (message.length == 0) {
    return;
  }
  NSMutableDictionary *locals = NSThread.currentThread.threadDictionary;
  if (locals[BGSRNConsoleCaptureKey] != nil) {
    return;
  }
  locals[BGSRNConsoleCaptureKey] = @YES;
  if (BGSRNConsoleCaptureEnabled()) {
    [BGSRNWrapperChannelHolder.shared logMessage:message
                                           level:BGSRNWireLevelForRCTLogLevel(level)];
  }
  [locals removeObjectForKey:BGSRNConsoleCaptureKey];
}

void BGSRNInstallConsoleCapture(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    RCTAddLogFunction(^(RCTLogLevel level,
                        RCTLogSource source,
                        __unused NSString *fileName,
                        __unused NSNumber *lineNumber,
                        NSString *message) {
      BGSRNOnRCTLog(level, source, message);
    });
  });
}
