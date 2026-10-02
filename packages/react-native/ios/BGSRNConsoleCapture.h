#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Installs the RCTLog hook once. Native-sourced lines (RN core, native
 * modules) are forwarded through the wrapper channel, source Custom, so they
 * meet the user's log filter once. JavaScript-sourced lines are the console
 * echo the JS patch already forwards; they are not forwarded again.
 *
 * Android already receives those native lines through logcat. iOS does not:
 * the SDK's os_log capture is disabled, and RCTLog's default function writes
 * only os_log of the raw message. This hook is the native capture. A stderr
 * stamp of a noted console line is dropped once, and so is one raw
 * stdout/stderr line of that text: that is the console echo. os_log capture
 * is off, and this package does not wait for an unstamped copy. Keeping the
 * channel line ends the equal-text claim. A later equal line is not dropped
 * as that copy, including `Bugsee.log`, a second `console.*`, or a native
 * `RCTLog` that never began a channel line.
 */
void BGSRNInstallConsoleCapture(void);

/** Arms a drop of the stderr stamp and one raw stdio line of `message`. Does not record a line. */
void BGSRNNoteConsoleEcho(NSString * _Nullable message);

/**
 * The wrapper channel is about to record `message`. The filter call inside
 * that record is the channel line. Keeping it clears the equal-text claim.
 * It does not arm a drop of the next equal line. Pair with
 * `BGSRNEndChannelLine`.
 */
void BGSRNBeginChannelLine(NSString * _Nullable message);

/** Ends the channel line begun with `message`. */
void BGSRNEndChannelLine(NSString * _Nullable message);

/**
 * YES when `line` is the console echo and should be dropped. `source` is the
 * event's log source, or a negative value when the event does not expose one.
 * A stderr stamp is dropped once. One raw stdout (1) or stderr (2) line of
 * the noted text is dropped once. Keeping the channel line clears the
 * equal-text claim; a later equal line that is not that stdio echo is not
 * dropped.
 */
BOOL BGSRNDropConsoleEcho(NSString * _Nullable line, NSInteger source);

NS_ASSUME_NONNULL_END
