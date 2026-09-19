#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Carries the SDK's lifecycle events from the wrapper to the React Native
/// bridge.
///
/// The two ends have different lifetimes, which is the whole reason this
/// exists. The wrapper is registered before React Native has a JS runtime and
/// is replaced once `setWrapperInfo` runs; the bridge appears later, can be
/// torn down and recreated by a reload, and is absent entirely during
/// start-up. Wiring the wrapper directly to a module would mean either
/// dropping events after a reload or holding a dead module alive.
///
/// Events that arrive with no bridge attached are dropped, deliberately.
/// During start-up there is no JavaScript to deliver them to, and queueing
/// would deliver a burst of stale transitions the moment JS appeared — worse
/// than not delivering them, because it looks like the present. A caller that
/// needs the current state asks `getStatus`.
@interface BGSRNEventBus : NSObject

@property (class, readonly) BGSRNEventBus *shared;

/// Attaches the bridge. Replaces whatever was attached.
- (void)attach:(id)sink block:(void (^)(NSString *name, NSString *_Nullable reportId))block;

/// Detaches `sink` only if it is still the attached one.
///
/// Identity-checked rather than an unconditional clear: a reload can construct
/// and attach the new module before the old one is torn down, and clearing
/// unconditionally would then silence the live bridge.
- (void)detach:(id)sink;

/// Forwards a lifecycle event, with the SDK's `com.bugsee.lifecycle.` prefix
/// removed. An unrecognised name is forwarded unchanged rather than dropped —
/// a newer SDK adding an event must not be swallowed by an older wrapper.
- (void)emitLifecycle:(NSString *)rawName reportId:(nullable NSString *)reportId;

@end

NS_ASSUME_NONNULL_END
