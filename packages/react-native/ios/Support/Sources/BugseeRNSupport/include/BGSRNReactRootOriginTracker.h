#import <UIKit/UIKit.h>

@class BGSRNSecureRectangles;

NS_ASSUME_NONNULL_BEGIN

/// Keeps the secure-rectangle store's origin on the window JS measures in: the
/// iOS peer of Android's `ReactRootOriginTracker`.
///
/// JS measures secure views with `measureInWindow`, in the window's points;
/// the SDK wants them where it draws them, and on iOS it records every window
/// of the app at its place on the screen. The tracker reads where the window
/// hosting the React root starts there and records it as display 0's origin --
/// display 0 is the screen the app is on, the only one the SDK pulls on iOS.
///
/// It keeps the React root view it found, weakly, and follows `root.window`,
/// which costs nothing and still answers when the root is moved into another
/// window. Searching the windows for a root happens only on a JS publish, and
/// only when the root found last has left its window: the SDK pulls on the
/// main thread once per captured frame, and in an app showing no React root
/// at all (the native screens of a brownfield app) a search would walk every
/// window to its budget each time.
///
/// One root, as on Android: with React roots in two windows, it follows the
/// first one found until that one leaves its window, and the rectangles JS
/// measured in the other window are moved by the wrong origin.
///
/// Main thread only: it reads UIKit.
@interface BGSRNReactRootOriginTracker : NSObject

/// @param findRoot the React root view, or nil.
/// @param readOrigin where a window starts in the frame the SDK records, a
///        boxed `CGPoint`, or nil when it is on no screen.
- (instancetype)initWithStore:(BGSRNSecureRectangles *)store
                     findRoot:(UIView *_Nullable (^)(void))findRoot
                   readOrigin:(NSValue *_Nullable (^)(UIWindow *window))readOrigin
    NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// For a JS publish: searches for the React root when the one found last has
/// left its window -- a publish means a root measured something -- then
/// records where its window starts.
- (void)refreshFindingTheRoot;

/// A JS publish: `-refreshFindingTheRoot`, then `coordinates` (packed int32,
/// four per rectangle, in the root's window) written to the store for
/// `display`. In that order and on main, where the SDK pulls. Written first,
/// the rectangles would be served at the origin the store held before for any
/// pull between the two -- `CGPointZero` until the first one is read -- and a
/// window away from the screen's origin would be recorded in the clear for
/// that frame. Android has no such gap: it reads its origin on host resume and
/// on every layout of the root, before JS can measure anything.
///
/// @return NO, publishing nothing, when `coordinates` is not whole rectangles.
- (BOOL)publishCoordinates:(NSData *)coordinates forDisplay:(NSInteger)display;

/// For the SDK's pulls: records where the window of the root found last starts
/// now, without searching. A window can move (Stage Manager, Split View) with
/// nothing published.
///
/// Both keep the last origin when the root, its window or its place cannot be
/// read: a guessed origin would move every region off the view it covers. Both
/// never throw -- they run inside the SDK's pull.
- (void)refresh;

@end

NS_ASSUME_NONNULL_END
