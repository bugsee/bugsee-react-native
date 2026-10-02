#import "BGSRNReactRootOriginTracker.h"

#import "BGSRNSecureRectangles.h"

@implementation BGSRNReactRootOriginTracker {
  BGSRNSecureRectangles *_store;
  UIView *_Nullable (^_findRoot)(void);
  NSValue *_Nullable (^_readOrigin)(UIWindow *window);
  /// The React root found last. Weak: a reload replaces it, and the tracker
  /// must not keep the old one alive.
  __weak UIView *_root;
}

- (instancetype)initWithStore:(BGSRNSecureRectangles *)store
                     findRoot:(UIView *_Nullable (^)(void))findRoot
                   readOrigin:(NSValue *_Nullable (^)(UIWindow *window))readOrigin {
  self = [super init];
  if (self) {
    _store = store;
    _findRoot = [findRoot copy];
    _readOrigin = [readOrigin copy];
  }
  return self;
}

- (void)refreshFindingTheRoot {
  [self refreshFinding:YES];
}

- (void)refresh {
  [self refreshFinding:NO];
}

- (BOOL)publishCoordinates:(NSData *)coordinates forDisplay:(NSInteger)display {
  [self refreshFindingTheRoot];
  return [_store setCoordinates:(const int32_t *)coordinates.bytes
                          count:coordinates.length / sizeof(int32_t)
                     forDisplay:display];
}

- (void)refreshFinding:(BOOL)find {
  @try {
    UIView *root = _root;
    if (root.window == nil && find) {
      root = _findRoot();
      _root = root;
    }
    UIWindow *window = [root isKindOfClass:UIWindow.class] ? (UIWindow *)root : root.window;
    if (window == nil) {
      return;
    }
    NSValue *origin = _readOrigin(window);
    if (origin == nil) {
      return;
    }
    [_store setOrigin:origin.CGPointValue forDisplay:0];
  } @catch (NSException *exception) {
    NSLog(@"[Bugsee] secure rectangles: could not read the React root's place on the screen: %@",
          exception);
  }
}

@end
