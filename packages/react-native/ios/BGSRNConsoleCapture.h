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
 * os_log. This hook is that capture.
 */
void BGSRNInstallConsoleCapture(void);

NS_ASSUME_NONNULL_END
