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
 * stamp of a noted console line is dropped here. The JS claim does not wait
 * for an unstamped copy. One equal line that is not the channel line being
 * recorded is the echo and is dropped once.
 */
void BGSRNInstallConsoleCapture(void);

/** Arms a drop of the stderr stamp of `message`. Does not record a line. */
void BGSRNNoteConsoleEcho(NSString * _Nullable message);

/**
 * The wrapper channel is about to record `message`. That filter request is
 * the channel line and is kept. The echo credit stays until an equal line
 * that is not this channel line is dropped, or the note expires. A later
 * `Bugsee.log` is itself a channel line, so it is kept.
 */
void BGSRNBeginChannelLine(NSString * _Nullable message);

/** YES when `line` is the echo of a live note. The note is consumed. */
BOOL BGSRNDropConsoleEcho(NSString * _Nullable line);

NS_ASSUME_NONNULL_END
