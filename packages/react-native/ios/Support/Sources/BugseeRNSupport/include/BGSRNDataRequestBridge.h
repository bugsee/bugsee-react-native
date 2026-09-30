#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The one data-request type this bridge takes to JS: the SDK's
/// `BGSManagedHierarchyDataType` (`BGSCaptureDataProviderViewHierarchy.m`),
/// and JS's `VH_DATA_TYPE`. Every other type is answered `nil` here.
FOUNDATION_EXPORT NSString *const BGSRNDataRequestTypeViewHierarchy;

/// How long JS gets to answer, in milliseconds. Kept under the SDK's own
/// `BGSManagedHierarchyTimeoutMs` (500): past that the SDK records the pass
/// without the managed half and ignores a late answer, so this bridge answers
/// `nil` itself first -- which the SDK counts as an answer, so a slow JS never
/// pushes it into its 50 ms "silent wrapper" mode.
FOUNDATION_EXPORT const int64_t BGSRNDataRequestDeadlineMs;

/// Receives each `onDataRequest` payload: `requestId`, `type`, `originX`,
/// `originY`. Returns whether it reached JS; NO answers the request `nil` at
/// once (`by=sink-threw`). Must not throw (see `BGSRNGuardedEmit`).
typedef BOOL (^BGSRNDataRequestSinkBlock)(NSDictionary<NSString *, id> *request);

/// The React root's on-screen origin, in points, as an `NSValue` wrapping a
/// `CGPoint`; nil when there is none. Called on the requesting thread (main).
typedef NSValue *_Nullable (^BGSRNDataRequestOriginBlock)(void);

/// The SDK's answer callback.
typedef void (^BGSRNDataRequestReply)(NSString *_Nullable data);

/// Arms a request's deadline; returns a token the matching cancel block takes.
typedef id _Nonnull (^BGSRNDataRequestScheduler)(dispatch_block_t task, int64_t delayMs);
typedef void (^BGSRNDataRequestSchedulerCancel)(id token);
/// A monotonic clock, in milliseconds.
typedef int64_t (^BGSRNDataRequestClock)(void);
/// Where the one-line outcome of every request goes. `NSLog` in production,
/// which reaches the console stream the device tests match.
typedef void (^BGSRNDataRequestOutcomeLog)(NSString *line);

/// Answers the SDK's `"vh"` data request from JS, through a table of opaque
/// request ids. The iOS mirror of Android's `DataRequestBridge`, and built
/// like `BGSRNReportHandlerBridge`.
///
/// Every `requestType:reply:` ends in exactly one run of `reply`, whichever
/// gets there first: JS completing the id, the deadline, or the sink
/// detaching (a reload), or the bridge failing (`by=failed`: the origin block
/// or the scheduler threw). Everything that cannot reach JS -- an unknown
/// type, no JS runtime or a disabled view tree, no origin -- answers `nil`
/// synchronously. The guard is one flag per request, flipped under the
/// registry lock; `reply` always runs OUTSIDE the lock, because it re-enters
/// the SDK (and may, in principle, re-enter this bridge).
///
/// Threading (SDK `0d9c9d0a3`, `BGSCaptureDataProviderViewHierarchy.m`): the
/// SDK asks on MAIN (`capturePassAskingWrapper:`, reached by
/// `dispatch_async(dispatch_get_main_queue(), ...)`), but never waits there:
/// the answer is an asynchronous callback, accepted on any thread, and the
/// only thread that blocks for it is the SDK's background reporting thread
/// (the snapshot path's semaphore). JS's answer arrives on the TurboModule
/// method queue, and the deadline fires on this bridge's own queue; neither
/// needs main. Nothing here hops to main, and nothing may.
///
/// Like `BGSRNReportHandlerBridge`, this outlives any one React instance: the
/// wrapper that calls in is registered at process start, while the module
/// that receives `onDataRequest` comes and goes with the JS runtime.
@interface BGSRNDataRequestBridge : NSObject

@property (class, readonly) BGSRNDataRequestBridge *shared;

/// Tests inject the scheduler and the clock; `shared` uses a private serial
/// queue and the uptime clock.
- (instancetype)initWithScheduler:(BGSRNDataRequestScheduler)schedule
                           cancel:(BGSRNDataRequestSchedulerCancel)cancel
                            clock:(BGSRNDataRequestClock)nowMs;

/// As above, with the outcome lines sent to `log` instead of `NSLog`.
- (instancetype)initWithScheduler:(BGSRNDataRequestScheduler)schedule
                           cancel:(BGSRNDataRequestSchedulerCancel)cancel
                            clock:(BGSRNDataRequestClock)nowMs
                              log:(BGSRNDataRequestOutcomeLog)log NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// Whether the attached JS runtime has a mounted `Bugsee.wrap` anchor to walk.
/// The setter writes the flag directly and does not identity-check; production
/// goes through `setViewTreeEnabled:forSink:`.
@property (atomic) BOOL viewTreeEnabled;

/// The attached runtime's anchor mounted (YES) or unmounted (NO). Ignored
/// when `sink` is not the attached one: the flag is process-wide, and a
/// reload can still run the old module's last disable after the new module
/// has attached and enabled. Applying that write would leave the live
/// runtime at `by=no-js` until its anchor count passed through zero again.
- (void)setViewTreeEnabled:(BOOL)enabled forSink:(id)sink;

/// Attaches the module of a new JS runtime, replacing whatever was attached,
/// and disables the view tree: the new runtime has not mounted its anchor
/// yet. `sink` is held weakly.
- (void)attach:(id)sink block:(BGSRNDataRequestSinkBlock)block origin:(BGSRNDataRequestOriginBlock)origin;

/// Answers `nil` to every request emitted to `sink` -- nothing in any other
/// runtime knows them. Clears the sink, the origin and the enabled flag only
/// if `sink` is still the attached one: a fast reload attaches the new module
/// before the old one is invalidated.
- (void)detach:(id)sink;

/// The wrapper's `requestDataWithType:callback:`. Never throws; `reply` runs
/// exactly once.
- (void)requestType:(NSString *)type reply:(BGSRNDataRequestReply)reply;

/// JS's answer. An unknown, finished or late id is ignored.
/// @return YES only for the call that delivered `payload` to the SDK.
- (BOOL)complete:(NSString *)requestId payload:(nullable NSString *)payload;

/// Requests minted and not yet completed. For tests: every terminal path must
/// bring this back to zero.
@property (nonatomic, readonly) NSUInteger outstanding;

@end

NS_ASSUME_NONNULL_END
