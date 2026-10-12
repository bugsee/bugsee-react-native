#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// WORKAROUND for https://github.com/bugsee/bugsee-cocoa/issues/227 -- remove
/// this class, and its call sites in BugseeModule.mm, once that is fixed.
///
/// iOS 7.0.0-beta5 drops a report-creating call made while the SDK is
/// `Launching`: `+logException:asHandled:withOptions:andCompletion:`
/// (`Bugsee.m:1431` at c015f6ba2), `+uploadWithSummary:` (1647),
/// `+createReportWithCompletion:` (1748) and `+showReportDialog...` (861,
/// 1327, 1355) all return when the status is not `Launched`, silently, and
/// call any completion. `launch()` resolves while the status is still
/// `Launching` -- `Launched` comes from an asynchronous completion, up to the
/// SDK's 8 s drain budget later on a device -- so `await launch()` followed by
/// `logException` lost the report on iOS, while Android kept it.
///
/// This holds such calls while the SDK is `Launching` and replays them, in
/// order, once it is `Launched`. A call made when nothing is held runs at
/// once, exactly as before, whatever the status.
///
/// Main thread only, except `lifecycleEvent:`: every SDK entry point already
/// runs there (`BGSRNRunOnMain`), and so do the status reads, the replay and
/// the deadline, so the hold needs no lock and keeps call order for free.
@interface BGSRNLaunchHold : NSObject

/// How a gated call is asked to run.
typedef NS_ENUM(NSInteger, BGSRNGatedRun) {
  /// Nothing was held: run it now, as the bridge always did.
  BGSRNGatedRunNow = 0,
  /// It was held and the SDK is now `Launched`: run it now.
  BGSRNGatedRunReplay = 1,
  /// It was held and the launch did not complete (stopped, stopping, the
  /// deadline passed, or the hold was full): do not call the SDK. Settle it
  /// the way the SDK settles a dropped call -- no report, and any promise
  /// resolves as the SDK's completion would have (nil).
  BGSRNGatedRunDrop = 2,
};

typedef void (^BGSRNGatedCall)(BGSRNGatedRun run);

/// The most calls held at once (`BGSRNLaunchHoldCapacity`). One more is
/// dropped at once, logged.
FOUNDATION_EXPORT const NSUInteger BGSRNLaunchHoldCapacity;

/// How long the first held call waits for `Launched` before every held call
/// is settled anyway (`BGSRNLaunchHoldDeadlineMs`): well past the SDK's 8 s
/// synchronous drain budget, and short enough that a launch which never
/// finishes cannot keep a promise pending for good.
FOUNDATION_EXPORT const int64_t BGSRNLaunchHoldDeadlineMs;

/// The process-wide hold, reading `+[Bugsee sharedInstance].status`.
@property (class, readonly) BGSRNLaunchHold *shared;

/// For tests: a hold with its own bounds, and the SDK status read from
/// `status`.
- (instancetype)initWithCapacity:(NSUInteger)capacity
                      deadlineMs:(int64_t)deadlineMs
                          status:(BugseeStatus (^)(void))status NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// Main thread only. Runs `call` now (`BGSRNGatedRunNow`), or holds it when
/// the SDK is `Launching`. Anything already held is settled first, so calls
/// keep their order across `Launched` even when this arrives before the
/// lifecycle event does. `label` names the call in the log lines, e.g.
/// `BugseeRN <label> held until launched`.
- (void)submit:(NSString *)label call:(BGSRNGatedCall)call;

/// Any thread: the SDK's `com.bugsee.lifecycle.*` event. `Launched` replays
/// what is held; `Stopping` and `Stopped` drop it. Hops to main.
- (void)lifecycleEvent:(NSString *)name;

/// Main thread only. How many calls are held.
@property (nonatomic, readonly) NSUInteger heldCount;

@end

NS_ASSUME_NONNULL_END
