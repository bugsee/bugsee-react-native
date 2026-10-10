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

static const NSTimeInterval BGSRNEchoWindowSeconds = 2.0;
static const NSUInteger BGSRNEchoNoteCap = 32;

/// Stdout and stderr. The console echo of `console.log` arrives on one of
/// these. A Custom line, including `Bugsee.log` and a native RCTLog forwarded
/// by this hook, does not.
static const NSInteger BGSRNLogSourceStdOut = 1;
static const NSInteger BGSRNLogSourceStdErr = 2;

/// Set only around the wrapper channel's own logMessage. The filter runs on
/// that same thread, so this call is the channel line. Keeping it ends the
/// equal-text claim. It does not consume the one-shot stdio echo.
static __thread int BGSRNChannelDepth;

@interface BGSRNEchoNote : NSObject
@property (nonatomic, copy) NSString *text;
@property (nonatomic, assign) NSTimeInterval expires;
/// Equal-text claim. Cleared when the channel line is kept. Not a drop of a
/// later Custom line.
@property (nonatomic, assign) BOOL exact;
/// One stderr stamp of `text`. Independent of `exact`.
@property (nonatomic, assign) BOOL stamp;
/// One raw stdout or stderr line of `text`. Independent of `exact`.
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
      // The channel line. Keeping it ends the equal-text claim. A later
      // Custom line of the same text is not the echo. A stdio line is the
      // echo even when it is filtered on this thread.
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

/// Native warnings React Native re-logs from JS. In a Debug build
/// `_RCTLogNativeInternal` also calls `RCTLog.logIfNoNativeHook`, and
/// LogBox's warning handler passes a `warn` to the `console.warn` it saved
/// before any patch. That reaches RCTLog a second time, as
/// `RCTLogSourceJavaScript`, with the same text. This hook does not record
/// it, but whatever the log function chain writes for it (an app's stderr
/// mirror, an NSLog) is a second echo of the line already recorded. Each
/// entry arms one more echo drop when that delivery arrives. Under the echo
/// lock.
static NSMutableArray<BGSRNEchoNote *> *BGSRNRelogNotes;

static void BGSRNExpectJsRelog(NSString *message) {
  @synchronized(BGSRNEchoLock()) {
    const NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    if (BGSRNRelogNotes == nil) {
      BGSRNRelogNotes = [NSMutableArray array];
    }
    BGSRNEchoNote *note = [BGSRNEchoNote new];
    note.text = message;
    note.expires = now + BGSRNEchoWindowSeconds;
    [BGSRNRelogNotes addObject:note];
    while (BGSRNRelogNotes.count > BGSRNEchoNoteCap) {
      [BGSRNRelogNotes removeObjectAtIndex:0];
    }
  }
}

/// YES once per expected relog of `message`, within the echo window.
static BOOL BGSRNClaimJsRelog(NSString *message) {
  @synchronized(BGSRNEchoLock()) {
    const NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    for (NSInteger index = (NSInteger)BGSRNRelogNotes.count - 1; index >= 0; index--) {
      if (BGSRNRelogNotes[(NSUInteger)index].expires <= now) {
        [BGSRNRelogNotes removeObjectAtIndex:(NSUInteger)index];
      }
    }
    for (NSUInteger index = 0; index < BGSRNRelogNotes.count; index++) {
      if ([BGSRNRelogNotes[index].text isEqualToString:message]) {
        [BGSRNRelogNotes removeObjectAtIndex:index];
        return YES;
      }
    }
    return NO;
  }
}

/**
 * Runs before the rest of the log function chain, so every echo drop is
 * armed before anything in that chain can write the line where the SDK
 * captures it. Returns YES when this line is to be recorded on the channel
 * after the chain has run.
 *
 * JavaScript source is the console echo. The JS patch forwards that call in
 * dev and in release; recording it here would run the filter twice. Release
 * builds often never produce this source for console.*, and dropping the
 * patch instead of this echo would drop those logs. A JavaScript delivery
 * that is the relog of a native warning arms one more echo drop.
 *
 * A native line is recorded here, once, and its echo drop is armed the way
 * the JS patch arms one for a console call: a stderr stamp and one raw
 * stdout or stderr line of that text.
 */
static BOOL BGSRNBeginRCTLog(RCTLogLevel level, RCTLogSource source, NSString *message) {
  if (message.length == 0) {
    return NO;
  }
  if (source == RCTLogSourceJavaScript) {
    if (BGSRNClaimJsRelog(message)) {
      BGSRNNoteConsoleEcho(message);
    }
    return NO;
  }
  if (NSThread.currentThread.threadDictionary[BGSRNConsoleCaptureKey] != nil) {
    return NO;
  }
  if (!BGSRNConsoleCaptureEnabled()) {
    return NO;
  }
  BGSRNNoteConsoleEcho(message);
#if RCT_DEBUG
  if (level == RCTLogLevelWarning) {
    BGSRNExpectJsRelog(message);
  }
#endif
  return YES;
}

/// Records a native line on the channel, as Custom. The filter runs inside
/// this call on this thread: that is the channel line, which is kept.
static void BGSRNForwardRCTLog(RCTLogLevel level, NSString *message) {
  NSMutableDictionary *locals = NSThread.currentThread.threadDictionary;
  locals[BGSRNConsoleCaptureKey] = @YES;
  BGSRNBeginChannelLine(message);
  @try {
    [BGSRNWrapperChannelHolder.shared logMessage:message
                                           level:BGSRNWireLevelForRCTLogLevel(level)];
  } @finally {
    BGSRNEndChannelLine(message);
    [locals removeObjectForKey:BGSRNConsoleCaptureKey];
  }
}

/**
 * Wraps the current log function rather than appending to it
 * (`RCTAddLogFunction` runs the existing function first): the echo drop of a
 * line must be armed before the existing function writes that line to
 * stderr, or the SDK could capture and filter the echo first.
 */
void BGSRNInstallConsoleCapture(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    RCTLogFunction existing = RCTGetLogFunction();
    RCTSetLogFunction(^(RCTLogLevel level,
                        RCTLogSource source,
                        NSString *fileName,
                        NSNumber *lineNumber,
                        NSString *message) {
      const BOOL forward = BGSRNBeginRCTLog(level, source, message);
      if (existing != nil) {
        existing(level, source, fileName, lineNumber, message);
      }
      if (forward) {
        BGSRNForwardRCTLog(level, message);
      }
    });
  });
}
