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
 * os_log. This hook is that capture. A stderr stamp of a noted console line
 * is dropped here. The unstamped stderr copy is a different string and is
 * dropped in JS, where the equal-text claim dies with that drop.
 */
void BGSRNInstallConsoleCapture(void);

/** Arms a drop of the stderr stamp of `message`. Does not record a line. */
void BGSRNNoteConsoleEcho(NSString * _Nullable message);

/**
 * The wrapper channel is about to record `message`. The equal-text note is
 * cleared so a `Bugsee.log` of the same text is not dropped here. The
 * unstamped stderr echo is dropped in JS. A stamp note stays until the
 * stamp is dropped.
 */
void BGSRNBeginChannelLine(NSString * _Nullable message);

/** YES when `line` is the echo of a live note. The note is consumed. */
BOOL BGSRNDropConsoleEcho(NSString * _Nullable line);

NS_ASSUME_NONNULL_END
