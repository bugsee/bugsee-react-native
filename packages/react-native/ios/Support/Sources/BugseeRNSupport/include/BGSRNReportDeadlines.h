#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// How long JS gets to handle one report callback on iOS.
///
/// The SDK tells a handler which path it is on only by the thread it calls on
/// (`BGSContracts.h`, `BGSReportHandler`):
///
/// - LIVE: a report raised by the running app. Handlers run on the MAIN
///   thread, and the SDK waits for each completion, capped at 30 s per
///   handler. The JS deadline sits 5 s inside that cap: past it the SDK
///   proceeds without us, and anything JS writes afterwards lands on a report
///   that has moved on.
/// - RECOVERY: a report recovered on the next launch. Handlers run OFF main,
///   in a bounded 3 s window, and the SDK does NOT wait for the completion --
///   but it re-persists the report when a late completion arrives, until the
///   bundle is assembled. So, unlike Android, recovery still goes to JS, with
///   a deadline inside that 3 s window. JS edits there are best-effort, but
///   real.
///
/// Fixed, not derived from an option: iOS exposes no per-handler timeout
/// option (Android's `ReportHandlerCallbackTimeout` has no counterpart).

/// 5 s inside the SDK's 30 s per-handler cap on the live (main-thread) path.
FOUNDATION_EXPORT const int64_t BGSRNLiveDeadlineMs;

/// 0.5 s inside the SDK's 3 s bounded window on the recovery (off-main) path.
FOUNDATION_EXPORT const int64_t BGSRNRecoveryDeadlineMs;

/// The deadline for a dispatch on the main thread (live) or off it (recovery).
///
/// Takes the thread as an argument, rather than asking `NSThread` itself, so
/// the rule is testable; the caller passes `NSThread.isMainThread`.
FOUNDATION_EXPORT int64_t BGSRNDeadlineMs(BOOL onMainThread);

NS_ASSUME_NONNULL_END
