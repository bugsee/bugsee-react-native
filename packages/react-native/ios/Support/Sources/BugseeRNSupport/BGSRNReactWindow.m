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

UIView *BGSRNTaggedView(NSArray<UIWindow *> *windows, NSInteger tag, BOOL (^matches)(UIView *), NSUInteger budget) {
  for (UIWindow *window in windows) {
    NSMutableArray<UIView *> *queue = [NSMutableArray arrayWithObject:window];
    NSUInteger head = 0;
    while (head < queue.count && head < budget) {
      UIView *view = queue[head++];
      if (view.tag == tag && matches(view)) {
        return view;
      }
      [queue addObjectsFromArray:view.subviews];
    }
  }
  return nil;
}
