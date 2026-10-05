#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Where the `vh` request's origin comes from: the one number that puts the
/// React tree in the same space as the SDK's native tree.
///
/// The SDK's view-hierarchy engine (SDK `0d9c9d0a3`,
/// `BGSCaptureViewHierarchyEngine.m:118-171`) walks the key window's scene
/// windows plus the key window (`BGSTrackerApplication.m:219-320`), and places
/// every node at `[view.window convertRect:frame fromView:view.superview]` plus
/// `view.window.frame.origin` (`:334-336`). JS measures with `measureInWindow`
/// -- window-relative, like the first term -- so the origin it must add is the
/// `frame.origin` of the window that hosts the React root. Equal by
/// construction, whatever UIKit answers for the screen (Split View, Slide
/// Over, Stage Manager).
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

/// The first window whose view tree, searched breadth-first over at most
/// `budget` views per window, has a view `isReactRoot` accepts. `keyWindow` is
/// tried first, then `windows` in order. nil if none does.
FOUNDATION_EXPORT UIWindow *_Nullable BGSRNWindowHostingReactRoot(UIWindow *_Nullable keyWindow,
                                                                 NSArray<UIWindow *> *windows,
                                                                 BOOL (^isReactRoot)(UIView *view),
                                                                 NSUInteger budget);

/// That window's `frame.origin` (points), boxed as a `CGPoint`; nil when no
/// window hosts the React root -- a request then answers `by=no-origin`
/// rather than a tree offset by a guess.
FOUNDATION_EXPORT NSValue *_Nullable BGSRNReactRootOrigin(UIWindow *_Nullable keyWindow,
                                                          NSArray<UIWindow *> *windows,
                                                          BOOL (^isReactRoot)(UIView *view));

/// How many views `BGSRNTaggedView` inspects per window before moving on to
/// the next. A `<Modal>` host sits inside the React tree, deeper than a root,
/// so this is larger than `BGSRNReactRootSearchBudget`; it still keeps a
/// pathological native hierarchy from costing the main thread on every pull.
FOUNDATION_EXPORT const NSUInteger BGSRNModalHostSearchBudget;

/// The first view whose `tag` is `tag` and that `matches` accepts, searching
/// each of `windows` in order, breadth-first, over at most `budget` views per
/// window. A view with that tag that `matches` rejects does not end the
/// search, in its window or any other: Fabric sets a component view's `tag`
/// to its React tag, but it does not own every `tag` in a window, so a native
/// view (or another runtime's) can carry the same small integer. Unlike
/// `-[UIView viewWithTag:]`, which returns the first view with the tag
/// whatever it is. nil when none.
FOUNDATION_EXPORT UIView *_Nullable BGSRNTaggedView(NSArray<UIWindow *> *windows,
                                                    NSInteger tag,
                                                    BOOL (^matches)(UIView *view),
                                                    NSUInteger budget);

NS_ASSUME_NONNULL_END
