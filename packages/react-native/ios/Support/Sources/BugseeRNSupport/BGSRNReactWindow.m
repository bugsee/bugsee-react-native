#import "BGSRNReactWindow.h"

const NSUInteger BGSRNReactRootSearchBudget = 2000;

const NSUInteger BGSRNModalHostSearchBudget = 10000;

UIWindow *BGSRNSdkKeyWindow(void) {
  UIApplication *application = UIApplication.sharedApplication;
  if (application == nil) {
    return nil;
  }
  UIWindow *fallback = nil;
  UIWindow *stableForeground = nil;
  UIWindow *markedKey = nil;
  for (UIScene *scene in application.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) {
      continue;
    }
    UIWindow *sceneKey = ((UIWindowScene *)scene).keyWindow;
    if (sceneKey == nil) {
      continue;
    }
    fallback = sceneKey;
    if (scene.activationState != UISceneActivationStateForegroundActive) {
      continue;
    }
    if (sceneKey.isKeyWindow) {
      markedKey = sceneKey;
    }
    if (stableForeground == nil) {
      stableForeground = sceneKey;
    }
  }
  if (fallback == nil) {
    // The SDK's own last resort, deprecated but still what it reads.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    fallback = application.keyWindow;
#pragma clang diagnostic pop
  }
  return markedKey ?: (stableForeground ?: fallback);
}

NSArray<UIWindow *> *BGSRNSdkWalkedWindows(UIWindow *keyWindow) {
  if (keyWindow == nil) {
    return @[];
  }
  static BOOL hasSceneManifest = NO;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSDictionary *manifest = [NSBundle.mainBundle objectForInfoDictionaryKey:@"UIApplicationSceneManifest"];
    hasSceneManifest = [manifest isKindOfClass:NSDictionary.class] && manifest.count > 0;
  });
  NSArray<UIWindow *> *windows = nil;
  if (hasSceneManifest) {
    windows = keyWindow.windowScene.windows;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    windows = UIApplication.sharedApplication.windows;
#pragma clang diagnostic pop
  }
  return windows ?: @[];
}

/// Breadth-first: a React root is near the top of its window, and a deep
/// native subtree beside it should not be searched first.
static BOOL HostsReactRoot(UIWindow *window, BOOL (^isReactRoot)(UIView *), NSUInteger budget) {
  NSMutableArray<UIView *> *queue = [NSMutableArray arrayWithObject:window];
  NSUInteger head = 0;
  while (head < queue.count && head < budget) {
    UIView *view = queue[head++];
    if (isReactRoot(view)) {
      return YES;
    }
    [queue addObjectsFromArray:view.subviews];
  }
  return NO;
}

UIWindow *BGSRNWindowHostingReactRoot(UIWindow *keyWindow,
                                      NSArray<UIWindow *> *windows,
                                      BOOL (^isReactRoot)(UIView *),
                                      NSUInteger budget) {
  if (keyWindow != nil && HostsReactRoot(keyWindow, isReactRoot, budget)) {
    return keyWindow;
  }
  for (UIWindow *window in windows) {
    if (window != keyWindow && HostsReactRoot(window, isReactRoot, budget)) {
      return window;
    }
  }
  return nil;
}

NSValue *BGSRNReactRootOrigin(UIWindow *keyWindow, NSArray<UIWindow *> *windows, BOOL (^isReactRoot)(UIView *)) {
  UIWindow *window = BGSRNWindowHostingReactRoot(keyWindow, windows, isReactRoot, BGSRNReactRootSearchBudget);
  if (window == nil) {
    return nil;
  }
  // `frame.origin`, NOT the window's position in the screen's coordinate
  // space: the SDK adds exactly this (BGSCaptureViewHierarchyEngine.m:335-336).
  return [NSValue valueWithCGPoint:window.frame.origin];
}

/// A `<Modal>` host's view controller. Declared here rather than imported:
/// `RCTModalHostViewComponentView` implements `viewController` without
/// declaring it in its header, and the call is guarded by
/// `respondsToSelector:`.
@interface UIView (BGSRNModalHostController)
- (UIViewController *)viewController;
@end

UIView *BGSRNUniqueTaggedView(NSArray<UIWindow *> *windows, NSInteger tag, BOOL (^matches)(UIView *), NSUInteger budget) {
  UIView *found = nil;
  for (UIWindow *window in windows) {
    NSMutableArray<UIView *> *queue = [NSMutableArray arrayWithObject:window];
    NSUInteger head = 0;
    while (head < queue.count && head < budget) {
      UIView *view = queue[head++];
      if (view.tag == tag && matches(view)) {
        if (found != nil && found != view) {
          return nil;
        }
        found = view;
      }
      [queue addObjectsFromArray:view.subviews];
    }
  }
  return found;
}

NSValue *BGSRNModalHostOrigin(UIView *host) {
  if (![host respondsToSelector:@selector(viewController)]) {
    return nil;
  }
  UIViewController *controller = [host viewController];
  if (controller == nil || !controller.isViewLoaded) {
    return nil;
  }
  UIView *content = controller.view;
  UIWindow *window = content.window;
  if (window == nil) {
    return nil;
  }
  // For PR #30's rebase: the `window.frame.origin` term here must become the
  // same window-placement value #30 gives the main lane, so both lanes share
  // one convention.
  CGPoint inWindow = [content convertPoint:CGPointZero toView:nil];
  return [NSValue valueWithCGPoint:CGPointMake(inWindow.x + window.frame.origin.x, inWindow.y + window.frame.origin.y)];
}

NSValue *BGSRNSecureSurfaceOrigin(BGSRNSecureRectangles *store,
                                  NSInteger surface,
                                  NSArray<UIWindow *> *windows,
                                  BOOL (^isHost)(UIView *)) {
  UIView *host = [store hostForSurface:surface accepting:^BOOL(id candidate) {
    return [candidate isKindOfClass:UIView.class] && ((UIView *)candidate).tag == surface && isHost(candidate);
  }];
  if (host != nil) {
    // The current runtime's own host: not presented yet is no origin, not a
    // search that could find another runtime's.
    return BGSRNModalHostOrigin(host);
  }
  UIView *found = BGSRNUniqueTaggedView(windows, surface, isHost, BGSRNModalHostSearchBudget);
  return found == nil ? nil : BGSRNModalHostOrigin(found);
}
