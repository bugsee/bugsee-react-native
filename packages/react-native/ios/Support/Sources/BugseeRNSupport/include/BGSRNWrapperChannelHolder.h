#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * The SDK's wrapper channel, held for the whole process. The iOS mirror of
 * Android's `WrapperChannelHolder`.
 *
 * The channel is how this wrapper submits what it captured in JS -- log
 * lines now, network events and breadcrumbs later -- attributed as wrapper
 * data rather than as the app's own calls. It is delivered to whichever
 * wrapper is registered, through `-onWrapperChannelAvailable:`, but it is
 * stored here rather than on that instance: the wrapper is replaced when
 * `setWrapperInfo` refines the identity, and the SDK hands the replacement a
 * fresh channel. The last one delivered is the live one; an earlier one goes
 * inert (the SDK itself reports stale use of it, after a grace period).
 *
 * Nothing is buffered. A channel held before `launch` accepts and drops what
 * it is given, which is the SDK's own behaviour, not an error this holder
 * works around.
 *
 * Every channel method is `@optional`, so each call here is guarded with
 * `respondsToSelector:`. There is deliberately no `@try` around a call: the
 * SDK already catches whatever the app's filter throws at `-postEvent:` and
 * drops the line, and unwinding an Objective-C exception through these ARC
 * frames would leak rather than protect anything (unlike Android, which lets
 * the exception reach the calling thread on purpose).
 */
@interface BGSRNWrapperChannelHolder : NSObject

@property (class, readonly) BGSRNWrapperChannelHolder *shared;

/**
 * The channel most recently delivered, or nil before one arrives or after it
 * is cleared. Lives outside the wrapper object on purpose -- see the class
 * comment.
 */
@property (atomic, strong, nullable) id<BGSWrapperChannel> channel;

/**
 * One JS line, as source `Custom` with no tag.
 *
 * The tag is always nil: iOS has nowhere to put one, and a line must read the
 * same on both platforms. The source is always set explicitly here, never
 * left to the SDK, which on iOS reads a missing source as `Unknown` rather
 * than `Custom`.
 *
 * `level` is the wire value, 1 (Error) .. 5 (Verbose); anything outside that
 * range becomes `Info`. Never `BugseeLogLevelInvalid` (0), which is not a
 * level a log line can honestly carry.
 */
- (void)logMessage:(nullable NSString *)message level:(NSInteger)level;

/**
 * Always `requiresFiltering:YES`. `NO` would also skip the SDK's own network
 * sanitizer, not only the app's filter, and nothing this wrapper sends has
 * been through either.
 */
- (void)addNetworkEvent:(nullable BugseeNetworkEvent *)event;

@end

NS_ASSUME_NONNULL_END
