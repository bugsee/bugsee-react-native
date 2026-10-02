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

static const NSTimeInterval BGSRNEchoWindowSeconds = 2.0;
static const NSUInteger BGSRNEchoNoteCap = 32;

/// Stdout and stderr. The console echo arrives on one of these. A wrapper
/// channel line, including a native RCTLog forwarded by this hook, does not.
static const NSInteger BGSRNLogSourceStdOut = 1;
static const NSInteger BGSRNLogSourceStdErr = 2;

/// Set only around the wrapper channel's own logMessage. The filter runs on
/// that same thread, so this call is the channel line and not the echo.
static __thread int BGSRNChannelDepth;

@interface BGSRNEchoNote : NSObject
@property (nonatomic, copy) NSString *text;
@property (nonatomic, assign) NSTimeInterval expires;
/// Equal-text claim. Cleared when the channel line is kept. Not a drop of the
/// next equal line.
@property (nonatomic, assign) BOOL exact;
@property (nonatomic, assign) BOOL stamp;
/// One raw stdout/stderr line of `text`. Independent of `exact`.
@property (nonatomic, assign) BOOL stdio;
@end

@implementation BGSRNEchoNote
@end

static NSMutableArray<BGSRNEchoNote *> *BGSRNEchoNotes;

static id BGSRNEchoLock(void) {
  static id lock;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    lock = [NSObject new];
    BGSRNEchoNotes = [NSMutableArray array];
  });
  return lock;
}

static BOOL BGSRNIsConsoleStamp(NSString *line, NSString *message) {
  if (message.length == 0 || line.length == 0) {
    return NO;
  }
  NSString *tail = [NSString stringWithFormat:@"] %@", message];
  if (![line hasSuffix:tail] || line.length <= tail.length) {
    return NO;
  }
  NSString *head = [line substringToIndex:line.length - tail.length];
  NSRange bracket = [head rangeOfString:@"["];
  if (bracket.location == NSNotFound || bracket.location == 0) {
    return NO;
  }
  NSString *when = [head substringToIndex:bracket.location];
  NSString *pid = [head substringFromIndex:NSMaxRange(bracket)];
  static NSRegularExpression *whenPattern;
  static NSRegularExpression *pidPattern;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    whenPattern = [NSRegularExpression
        regularExpressionWithPattern:@"^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+ [^\\s\\[]+$"
                             options:0
                               error:nil];
    pidPattern = [NSRegularExpression regularExpressionWithPattern:@"^\\d+:\\d+$"
                                                           options:0
                                                             error:nil];
  });
  if (whenPattern == nil || pidPattern == nil) {
    return NO;
  }
  NSRange whenRange = NSMakeRange(0, when.length);
  NSRange pidRange = NSMakeRange(0, pid.length);
  NSTextCheckingResult *whenMatch = [whenPattern firstMatchInString:when options:0 range:whenRange];
  NSTextCheckingResult *pidMatch = [pidPattern firstMatchInString:pid options:0 range:pidRange];
  return whenMatch != nil && whenMatch.range.length == when.length && pidMatch != nil &&
      pidMatch.range.length == pid.length;
}

static void BGSRNPruneEchoNotes(NSTimeInterval now) {
  for (NSInteger index = (NSInteger)BGSRNEchoNotes.count - 1; index >= 0; index--) {
    BGSRNEchoNote *note = BGSRNEchoNotes[(NSUInteger)index];
    if (note.expires <= now || (!note.exact && !note.stamp && !note.stdio)) {
      [BGSRNEchoNotes removeObjectAtIndex:(NSUInteger)index];
    }
  }
}

void BGSRNNoteConsoleEcho(NSString *message) {
  if (message == nil) {
    return;
  }
  @synchronized(BGSRNEchoLock()) {
    BGSRNPruneEchoNotes([NSDate date].timeIntervalSince1970);
    BGSRNEchoNote *note = [BGSRNEchoNote new];
    note.text = message;
    note.expires = [NSDate date].timeIntervalSince1970 + BGSRNEchoWindowSeconds;
    note.exact = YES;
    note.stamp = YES;
    note.stdio = YES;
    [BGSRNEchoNotes addObject:note];
    while (BGSRNEchoNotes.count > BGSRNEchoNoteCap) {
      [BGSRNEchoNotes removeObjectAtIndex:0];
    }
  }
}

void BGSRNBeginChannelLine(NSString *message) {
  if (message == nil) {
    return;
  }
  BGSRNChannelDepth++;
}

void BGSRNEndChannelLine(NSString *message) {
  if (message == nil || BGSRNChannelDepth <= 0) {
    return;
  }
  BGSRNChannelDepth--;
}

static BOOL BGSRNNoteIsSpent(BGSRNEchoNote *note) {
  return !note.exact && !note.stamp && !note.stdio;
}

static BOOL BGSRNIsStdioSource(NSInteger source) {
  return source == BGSRNLogSourceStdOut || source == BGSRNLogSourceStdErr;
}

BOOL BGSRNDropConsoleEcho(NSString *line, NSInteger source) {
  if (line.length == 0) {
    return NO;
  }
  @synchronized(BGSRNEchoLock()) {
    BGSRNPruneEchoNotes([NSDate date].timeIntervalSince1970);
    for (NSInteger index = 0; index < (NSInteger)BGSRNEchoNotes.count; index++) {
      BGSRNEchoNote *note = BGSRNEchoNotes[(NSUInteger)index];
      if (note.stamp && BGSRNIsConsoleStamp(line, note.text)) {
        note.stamp = NO;
        if (BGSRNNoteIsSpent(note)) {
          [BGSRNEchoNotes removeObjectAtIndex:(NSUInteger)index];
        }
        return YES;
      }
    }
    for (NSInteger index = 0; index < (NSInteger)BGSRNEchoNotes.count; index++) {
      BGSRNEchoNote *note = BGSRNEchoNotes[(NSUInteger)index];
      if (![note.text isEqualToString:line]) {
        continue;
      }
      // The channel line. The equal-text claim dies here. A later equal line
      // is not dropped as the echo. A stdio line is the echo even when it is
      // filtered on this thread.
      if (BGSRNChannelDepth > 0 && note.exact && !BGSRNIsStdioSource(source)) {
        note.exact = NO;
        if (BGSRNNoteIsSpent(note)) {
          [BGSRNEchoNotes removeObjectAtIndex:(NSUInteger)index];
        }
        return NO;
      }
      if (note.stdio && BGSRNIsStdioSource(source)) {
        note.stdio = NO;
        if (BGSRNNoteIsSpent(note)) {
          [BGSRNEchoNotes removeObjectAtIndex:(NSUInteger)index];
        }
        return YES;
      }
    }
    return NO;
  }
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
