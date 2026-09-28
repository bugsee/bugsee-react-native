#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, BGSRNReportPhase) {
  BGSRNReportPhaseBefore,
  BGSRNReportPhaseAfter,
};

/// Receives each `onReportHandlerRequest` payload: `handleId`, `phase`
/// (`"before"`/`"after"`), `reportId`, `type` and `deadlineMs`.
typedef void (^BGSRNReportRequestBlock)(NSDictionary<NSString *, id> *request);

/// Arms a handle's deadline; returns a token the matching cancel block takes.
typedef id _Nonnull (^BGSRNReportScheduler)(dispatch_block_t task, int64_t delayMs);
typedef void (^BGSRNReportSchedulerCancel)(id token);
/// Where the one-line outcome of every dispatch goes. `NSLog` in production,
/// which reaches the `devicectl --console` stream the device tests match.
typedef void (^BGSRNReportOutcomeLog)(NSString *line);

/// Routes the SDK's report callbacks to JS and back, through a table of opaque
/// handles. The iOS mirror of Android's `ReportHandlerBridge`.
///
/// Every dispatch ends in exactly one run of the SDK's completion, whichever
/// gets there first: JS completing the handle, the handle's deadline, the
/// bridge detaching (a reload), or a failure to reach JS at all. The guard is
/// one flag per handle, flipped under the registry lock; the completion itself
/// always runs OUTSIDE the lock, because it re-enters the SDK.
///
/// Unlike Android, a recovered report (dispatched off the main thread) DOES
/// reach JS, with the shorter recovery deadline: see `BGSRNReportDeadlines.h`.
///
/// Nothing here hops to the main queue, and nothing may. On the live path the
/// SDK calls in on main via `dispatch_async`, but it does not wait there for
/// the completion: that completion is a thread-agnostic run-once that hops to
/// a private queue, so main is never blocked on it. The rule holds anyway --
/// there is no need to hop, and an op that did would queue behind whatever UI
/// work is already on main, eating into the handle's deadline for nothing.
///
/// Like `BGSRNEventBus`, this outlives any one React instance: the wrapper
/// that calls in is registered at process start, while the module that
/// receives comes and goes with the JS runtime.
@interface BGSRNReportHandlerBridge : NSObject

@property (class, readonly) BGSRNReportHandlerBridge *shared;

/// Tests inject the scheduler; `shared` uses a private serial queue.
- (instancetype)initWithScheduler:(BGSRNReportScheduler)schedule
                           cancel:(BGSRNReportSchedulerCancel)cancel;

/// As above, with the outcome lines sent to `log` instead of `NSLog`.
- (instancetype)initWithScheduler:(BGSRNReportScheduler)schedule
                           cancel:(BGSRNReportSchedulerCancel)cancel
                              log:(BGSRNReportOutcomeLog)log NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// Which phases the attached JS runtime wants delivered.
- (void)setPhasesBefore:(BOOL)before after:(BOOL)after;

/// Attaches the module of a new JS runtime, replacing whatever was attached,
/// and clears the phases: the new runtime has registered none yet, and until
/// it does a dispatch must complete at once rather than wait on a listener
/// that does not exist. `sink` is held weakly.
- (void)attach:(id)sink block:(BGSRNReportRequestBlock)block;

/// Completes every handle emitted to `sink` -- nothing in any other runtime
/// knows them. Clears the sink and the phases only if `sink` is still the
/// attached one: a fast reload attaches the new module before the old one is
/// invalidated.
- (void)detach:(id)sink;

/// The wrapper's `onBeforeReportCreated:`/`onAfterReportCreated:`. The caller
/// passes `NSThread.isMainThread` as `onMain`, which selects the deadline.
- (void)dispatchPhase:(BGSRNReportPhase)phase
               report:(id<BGSReportContract>)report
        isTerminating:(BOOL)isTerminating
         onMainThread:(BOOL)onMain
           completion:(nullable BGSCallback)completion;

/// @return YES only for the call that ran the SDK completion.
- (BOOL)complete:(NSString *)handleId;

/// The live report behind `handleId`, or nil once it is completed.
- (nullable id<BGSReportContract>)reportFor:(NSString *)handleId;

@end

NS_ASSUME_NONNULL_END
