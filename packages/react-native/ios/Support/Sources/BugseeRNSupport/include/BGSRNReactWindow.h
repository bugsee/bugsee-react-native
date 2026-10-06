#import <UIKit/UIKit.h>

#import "BGSRNSecureRectangles.h"

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

/// The key window exactly as the SDK picks it (`+[BGSTrackerApplication
/// resolveKeyWindow]`): the application's key window while its scene is in the
/// foreground -- the window the user brought forward last, when several of the
/// app's scenes are on screen -- else, among window scenes with a key window,
/// the foreground-active one whose key window `isKeyWindow`, else the first
/// foreground-active one, else the last scene's key window seen. Not unit
/// tested: it needs connected scenes.
FOUNDATION_EXPORT UIWindow *_Nullable BGSRNSdkKeyWindow(void);

/// The windows the SDK records and walks for that key window
/// (`BGSWindowsToRecord`, `+[BGSTrackerApplication captureWindows]`). Where
/// the SDK composes the app's windows on the screen -- iOS, not on a Mac --
/// and the app declares a `UIApplicationSceneManifest` and has more than one
/// scene connected: the windows of every foreground window scene on the key
/// window's screen. Else its scene's windows with a manifest, or
/// `-[UIApplication windows]` without one -- which is the React Native
/// template's case. The SDK orders the scenes back to front; this list is for
/// finding a window, so it keeps `connectedScenes` order. Not unit tested
/// either: the test runner has no application and no scenes.
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

/// How many views `BGSRNUniqueTaggedView` inspects per window before moving
/// on to the next. A `<Modal>` host sits inside the React tree, deeper than a
/// root, so this is larger than `BGSRNReactRootSearchBudget`; it still keeps
/// a pathological native hierarchy from costing the main thread on a pull.
FOUNDATION_EXPORT const NSUInteger BGSRNModalHostSearchBudget;

/// The one view whose `tag` is `tag` and that `matches` accepts, searching
/// each of `windows` breadth-first over at most `budget` views per window.
/// nil when there is none, AND when there is more than one: Fabric sets a
/// component view's `tag` to its React tag, but tags are not a window-wide
/// namespace. A native view can carry the same small integer (a non-matching
/// view does not end the search, unlike `-[UIView viewWithTag:]`), and during
/// a reload two runtimes' hosts can share one tag, so two matches cannot say
/// which is current.
FOUNDATION_EXPORT UIView *_Nullable BGSRNUniqueTaggedView(NSArray<UIWindow *> *windows,
                                                          NSInteger tag,
                                                          BOOL (^matches)(UIView *view),
                                                          NSUInteger budget);

/// Where `measureInWindow`'s (0, 0) sits on the screen, in points, inside the
/// `<Modal>` whose host component view is `host`: the origin of the host's
/// presented view controller's view in its window, plus `windowOrigin` of
/// that window: where it starts in the frame the SDK records
/// (`BGSRNWindowRecordedOrigin`), the same window placement the main surface
/// uses. Fabric inserts the Modal's children into that view
/// (`RCTModalHostViewComponentView`), and `measureInWindow` inside a Modal
/// stops at the `ModalHostView` node with an identity transform, so this is
/// the window's origin for a full-screen Modal and inset for a `pageSheet` or
/// `formSheet` one. nil when `host` has no `viewController`, or that view is
/// not loaded or has no window (the Modal is not presented), or
/// `windowOrigin` has no place for the window (it is on no screen).
FOUNDATION_EXPORT NSValue *_Nullable BGSRNModalHostOrigin(UIView *host,
                                                         NSValue *_Nullable (^windowOrigin)(UIWindow *window));

/// The screen origin of `surface`, a `<Modal>` lane in `store`. Read from the
/// current runtime's host (`hostForSurface:accepting:`, which takes a view
/// `isHost` accepts with that tag) when there is one, even when that gives no
/// origin yet. nil while a host or lookup the current runtime named finds
/// nothing (`isHostNamedForSurface:`): the host mounts after the publish, and
/// until then the origin is unknown. Only when nothing was ever named (no
/// registry), the one view `isHost` accepts with that tag in `windows`
/// (`BGSRNUniqueTaggedView`); nil when there are none or several. A nil
/// leaves the lane's origin as it was: unknown for a new lane, which is
/// served as the whole display. `windowOrigin` places the host's window, as
/// for `BGSRNModalHostOrigin`. Main thread only.
FOUNDATION_EXPORT NSValue *_Nullable BGSRNSecureSurfaceOrigin(BGSRNSecureRectangles *store,
                                                              NSInteger surface,
                                                              NSArray<UIWindow *> *windows,
                                                              BOOL (^isHost)(UIView *view),
                                                              NSValue *_Nullable (^windowOrigin)(UIWindow *window));

NS_ASSUME_NONNULL_END
