#import "BGSRNReactWindow.h"

const NSUInteger BGSRNReactRootSearchBudget = 2000;

/// Whether the SDK composes the app's windows on the screen: iOS, and not an
/// iPhone or iPad app running on a Mac (`+[BGSTrackerApplication
/// capturesAppScreen]`).
static BOOL BGSRNSdkComposesScreen(void) {
#if TARGET_OS_MACCATALYST
  return NO;
#else
  return !NSProcessInfo.processInfo.isiOSAppOnMac;
#endif
}

/// A window scene the user can see: the SDK leaves background scenes out, as
/// they keep reporting their last place on a screen.
static BOOL BGSRNIsForeground(UIScene *scene) {
  return scene.activationState == UISceneActivationStateForegroundActive ||
         scene.activationState == UISceneActivationStateForegroundInactive;
}

UIWindow *BGSRNSdkKeyWindow(void) {
  UIApplication *application = UIApplication.sharedApplication;
  if (application == nil) {
    return nil;
  }
  // Since the iOS 15 SDK every scene's key window reports isKeyWindow, so with
  // two of the app's scenes on screen the loop below cannot tell which one the
  // user is in; the application's key window follows the one brought forward.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  UIWindow *applicationKeyWindow = application.keyWindow;
#pragma clang diagnostic pop
  if (applicationKeyWindow.windowScene != nil && BGSRNIsForeground(applicationKeyWindow.windowScene)) {
    return applicationKeyWindow;
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
  UIApplication *application = UIApplication.sharedApplication;
  UIScreen *screen = keyWindow.windowScene.screen;
  if (hasSceneManifest && BGSRNSdkComposesScreen() && application.connectedScenes.count > 1 &&
      screen != nil) {
    NSMutableArray<UIWindow *> *composed = [NSMutableArray array];
    for (UIScene *scene in application.connectedScenes) {
      if ([scene isKindOfClass:UIWindowScene.class] && BGSRNIsForeground(scene) &&
          ((UIWindowScene *)scene).screen == screen) {
        [composed addObjectsFromArray:((UIWindowScene *)scene).windows];
      }
    }
    if (composed.count > 0) {
      return composed;
    }
  }
  NSArray<UIWindow *> *windows = nil;
  if (hasSceneManifest) {
    windows = keyWindow.windowScene.windows;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    windows = application.windows;
#pragma clang diagnostic pop
  }
  return windows ?: @[];
}

/// Breadth-first: a React root is near the top of its window, and a deep
/// native subtree beside it should not be searched first.
static UIView *ReactRootInWindow(UIWindow *window, BOOL (^isReactRoot)(UIView *), NSUInteger budget) {
  NSMutableArray<UIView *> *queue = [NSMutableArray arrayWithObject:window];
  NSUInteger head = 0;
  while (head < queue.count && head < budget) {
    UIView *view = queue[head++];
    if (isReactRoot(view)) {
      return view;
    }
    [queue addObjectsFromArray:view.subviews];
  }
  return nil;
}

UIView *BGSRNReactRootView(UIWindow *keyWindow,
                           NSArray<UIWindow *> *windows,
                           BOOL (^isReactRoot)(UIView *),
                           NSUInteger budget) {
  UIView *root = keyWindow != nil ? ReactRootInWindow(keyWindow, isReactRoot, budget) : nil;
  if (root != nil) {
    return root;
  }
  for (UIWindow *window in windows) {
    if (window != keyWindow) {
      root = ReactRootInWindow(window, isReactRoot, budget);
      if (root != nil) {
        return root;
      }
    }
  }
  return nil;
}

UIWindow *BGSRNWindowHostingReactRoot(UIWindow *keyWindow,
                                      NSArray<UIWindow *> *windows,
                                      BOOL (^isReactRoot)(UIView *),
                                      NSUInteger budget) {
  UIView *root = BGSRNReactRootView(keyWindow, windows, isReactRoot, budget);
  // A root found in a window's tree is in that window, unless it is the window itself.
  return [root isKindOfClass:UIWindow.class] ? (UIWindow *)root : root.window;
}

NSValue *BGSRNReactRootOrigin(UIWindow *keyWindow, NSArray<UIWindow *> *windows, BOOL (^isReactRoot)(UIView *)) {
  UIWindow *window = BGSRNWindowHostingReactRoot(keyWindow, windows, isReactRoot, BGSRNReactRootSearchBudget);
  if (window == nil) {
    return nil;
  }
  // Not `frame.origin` on iOS: that is the window's place in its scene, {0, 0}
  // for a Stage Manager window or the right-hand one side by side, while the
  // SDK places its nodes on the screen.
  return BGSRNWindowRecordedOrigin(window);
}

NSValue *BGSRNWindowRecordedOrigin(UIWindow *window) {
  UIScreen *screen = window.windowScene.screen;
  if (screen == nil) {
    return nil;
  }
  if (!BGSRNSdkComposesScreen()) {
    return [NSValue valueWithCGPoint:window.frame.origin];
  }
  id<UICoordinateSpace> fixedSpace = screen.fixedCoordinateSpace;
  const CGRect inFixedSpace = [window convertRect:window.bounds toCoordinateSpace:fixedSpace];
  const CGRect onScreen = [fixedSpace convertRect:inFixedSpace
                                toCoordinateSpace:screen.coordinateSpace];
  return [NSValue valueWithCGPoint:onScreen.origin];
}
