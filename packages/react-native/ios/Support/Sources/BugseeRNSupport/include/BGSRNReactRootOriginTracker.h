#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// The shortest time between two searches for the React root on the SDK's
/// pulls, in seconds, while no root found earlier is in a window.
FOUNDATION_EXPORT const NSTimeInterval BGSRNReactRootSearchMinInterval;

/// Where the React root's window starts in the frame the SDK records: the main
/// surface's origin, what moves its secure rectangles and the `vh` tree onto
/// the screen. The iOS peer of Android's `ReactRootOriginTracker`.
///
/// The SDK pulls the secure rectangles on the main thread once per captured
/// frame and per report screenshot, and the main surface's origin is re-read
/// on each pull, so a window that moves (Stage Manager, Split View, iPhone Duo
/// side by side) is followed with nothing published. A search walks every
/// window the SDK walks, to its budget when there is no React root (a
/// brownfield app's native screens), so the tracker keeps the root it found
/// last, weakly -- a reload replaces it and it must not be kept alive -- and
/// only reads its window's place while it is in one. Without such a root a
/// pull searches at most once per `BGSRNReactRootSearchMinInterval`; a JS
/// publish or a `vh` request searches at once.
///
/// Never guesses: nil when there is no root, or its place cannot be read, and
/// the caller keeps the origin it has. Main thread only. An exception from
/// either block is logged and read as nil.
@interface BGSRNReactRootOriginTracker : NSObject

/// @param findRoot searches for the React root; nil when there is none.
/// @param readOrigin the place of the window holding the root.
/// @param clock seconds on a monotonic clock, for the pulls' search interval.
- (instancetype)initWithFindRoot:(UIView *_Nullable (^)(void))findRoot
                      readOrigin:(NSValue *_Nullable (^)(UIWindow *window))readOrigin
                           clock:(NSTimeInterval (^)(void))clock NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// For the SDK's pull: the origin of the root found last while it is in a
/// window. Without one, searches, at most once per
/// `BGSRNReactRootSearchMinInterval`.
- (nullable NSValue *)origin;

/// For a JS publish or a `vh` request: the same, but searching now whenever
/// the root found last is in no window.
- (nullable NSValue *)originFindingTheRoot;

@end

NS_ASSUME_NONNULL_END
