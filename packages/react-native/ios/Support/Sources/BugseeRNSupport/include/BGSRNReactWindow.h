#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Where the `vh` request's origin comes from: the one number that puts the
/// React tree in the same space as the SDK's native tree.
///
/// The SDK's view-hierarchy engine places every node in the frame it records
/// (`+[BGSTrackerApplication captureRectForRect:inView:]`,
/// `BGSCaptureViewHierarchyEngine.m` `dumpView:`): on iOS every window of the
/// app at its place on the screen (iPad Stage Manager and Split View, iPhone
/// Duo side by side). JS measures with `measureInWindow` -- window-relative --
/// so the origin it must add is where the window hosting the React root starts
/// in that frame (`BGSRNWindowRecordedOrigin`), the same origin that moves the
/// secure rectangles (`BGSRNReactRootOriginTracker`).
///
/// Everything here reads UIKit, so it must run on main.

/// How many views `BGSRNWindowHostingReactRoot` inspects per window before
/// giving up on it. A React root sits a few levels down in any real app; this
/// only keeps a pathological native hierarchy from costing the main thread.
FOUNDATION_EXPORT const NSUInteger BGSRNReactRootSearchBudget;

/// The key window exactly as the SDK picks it (`BGSTrackerApplication.m:
/// 219-264`): among window scenes with a key window, the foreground-active
/// one whose key window `isKeyWindow`, else the first foreground-active one,
/// else the last scene's key window seen, else the application's own. Not unit
/// tested: it needs connected scenes.
FOUNDATION_EXPORT UIWindow *_Nullable BGSRNSdkKeyWindow(void);

/// The windows the SDK walks for that key window (`BGSTrackerApplication.m:
/// 185-210, 295-320`): its scene's windows when the app declares a
/// `UIApplicationSceneManifest`, else `-[UIApplication windows]` -- which is
/// the React Native template's case: it declares no manifest.
FOUNDATION_EXPORT NSArray<UIWindow *> *BGSRNSdkWalkedWindows(UIWindow *_Nullable keyWindow);

/// The first view `isReactRoot` accepts, searching each window's tree
/// breadth-first over at most `budget` views. `keyWindow` is tried first, then
/// `windows` in order. nil if no window has one.
FOUNDATION_EXPORT UIView *_Nullable BGSRNReactRootView(UIWindow *_Nullable keyWindow,
                                                      NSArray<UIWindow *> *windows,
                                                      BOOL (^isReactRoot)(UIView *view),
                                                      NSUInteger budget);

/// The window hosting that view (`BGSRNReactRootView`), or nil.
FOUNDATION_EXPORT UIWindow *_Nullable BGSRNWindowHostingReactRoot(UIWindow *_Nullable keyWindow,
                                                                 NSArray<UIWindow *> *windows,
                                                                 BOOL (^isReactRoot)(UIView *view),
                                                                 NSUInteger budget);

/// Where that window starts in the frame the SDK records
/// (`BGSRNWindowRecordedOrigin`), boxed as a `CGPoint`; nil when no window
/// hosts the React root, or it is on no screen -- a request then answers
/// `by=no-origin` rather than a tree offset by a guess.
FOUNDATION_EXPORT NSValue *_Nullable BGSRNReactRootOrigin(UIWindow *_Nullable keyWindow,
                                                          NSArray<UIWindow *> *windows,
                                                          BOOL (^isReactRoot)(UIView *view));

/// Where `window`'s own coordinate space starts in the frame the SDK records,
/// in points, boxed as a `CGPoint`: what to add to a `measureInWindow`
/// rectangle to put it where the SDK draws it, as its secure-rectangle
/// contract wants. nil when the window is on no screen.
///
/// The SDK records every window of the app at its place on the screen on iOS,
/// so this is the window's place on its screen (interface orientation),
/// through the screen's fixed (portrait) space as the SDK places windows
/// (`+[BGSTrackerApplication screenRectForRect:inView:]`): converted straight
/// to `screen.coordinateSpace`, a scene that shares its screen (iPad tiling,
/// iPhone Duo side by side) reads {0, 0}. An iPhone or iPad app running on a
/// Mac, and Mac Catalyst, record the key window's scene alone, where the SDK
/// adds `frame.origin` (`+[BGSTrackerApplication captureRectForRect:inView:]`).
FOUNDATION_EXPORT NSValue *_Nullable BGSRNWindowRecordedOrigin(UIWindow *window);

NS_ASSUME_NONNULL_END
