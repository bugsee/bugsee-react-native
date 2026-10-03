#import <Foundation/Foundation.h>

@class BGSRNSecureRectangles;

NS_ASSUME_NONNULL_BEGIN

/// The fastest a pull asks for an origin refresh, in seconds. The same 100 ms
/// as Android's `SecureRectanglePulls`, and as JS's remeasure loop.
FOUNDATION_EXPORT const NSTimeInterval BGSRNOriginRefreshMinInterval;

/// Serves the SDK's secure-rectangle pull and uses it to keep the origin
/// fresh: the iOS peer of Android's `SecureRectanglePulls`.
///
/// The served rectangles are JS's measurements moved by the React root's
/// place on the screen (`BGSRNReactRootOriginTracker`). JS publishes only when
/// a measurement changes, and a window can move without one (Stage Manager,
/// Split View). So each pull also asks for a refresh, at most every
/// `BGSRNOriginRefreshMinInterval`. On the main thread, where the SDK pulls,
/// the refresh runs before the snapshot is taken and the pull already serves
/// the window's current place; off main it is posted to main and a later pull
/// serves it.
///
/// Process-wide, like the store: the wrapper the SDK pulls through is
/// replaced mid-session, while the refresher belongs to whichever module is
/// live.
@interface BGSRNSecureRectanglePulls : NSObject

@property (class, readonly) BGSRNSecureRectanglePulls *shared;

/// @param clock seconds from a monotonic source.
- (instancetype)initWithStore:(BGSRNSecureRectangles *)store
                        clock:(NSTimeInterval (^)(void))clock NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// What a pull runs to refresh the origin, or nil for none. A refresher that
/// throws is logged, and the snapshot is served regardless.
@property (atomic, copy, nullable) dispatch_block_t refresher;

/// The SDK's pull for `display`: refreshes the origin when due, then returns
/// the store's snapshot.
- (NSData *)pullForDisplay:(NSInteger)display;

@end

NS_ASSUME_NONNULL_END
