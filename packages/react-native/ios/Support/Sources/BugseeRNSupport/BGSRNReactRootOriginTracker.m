#import "BGSRNReactRootOriginTracker.h"

const NSTimeInterval BGSRNReactRootSearchMinInterval = 0.5;

@implementation BGSRNReactRootOriginTracker {
  UIView *_Nullable (^_findRoot)(void);
  NSValue *_Nullable (^_readOrigin)(UIWindow *window);
  NSTimeInterval (^_clock)(void);
  /// The React root found last. Weak: a reload replaces it, and the tracker
  /// must not keep the old one alive.
  __weak UIView *_root;
  BOOL _hasSearched;
  NSTimeInterval _lastSearch;
}

- (instancetype)initWithFindRoot:(UIView *_Nullable (^)(void))findRoot
                      readOrigin:(NSValue *_Nullable (^)(UIWindow *window))readOrigin
                           clock:(NSTimeInterval (^)(void))clock {
  self = [super init];
  if (self) {
    _findRoot = [findRoot copy];
    _readOrigin = [readOrigin copy];
    _clock = [clock copy];
  }
  return self;
}

- (NSValue *)origin {
  return [self originSearchingAtOnce:NO];
}

- (NSValue *)originFindingTheRoot {
  return [self originSearchingAtOnce:YES];
}

- (NSValue *)originSearchingAtOnce:(BOOL)atOnce {
  @try {
    UIView *root = _root;
    if (root.window == nil && [self claimSearch:atOnce]) {
      root = _findRoot();
      _root = root;
    }
    UIWindow *window = [root isKindOfClass:UIWindow.class] ? (UIWindow *)root : root.window;
    return window == nil ? nil : _readOrigin(window);
  } @catch (NSException *exception) {
    NSLog(@"BugseeRN secure origin lookup threw: %@", NSStringFromClass(exception.class));
    return nil;
  }
}

/// Whether a search may run now: always at once, else not within
/// `BGSRNReactRootSearchMinInterval` of the last one.
- (BOOL)claimSearch:(BOOL)atOnce {
  const NSTimeInterval now = _clock();
  if (!atOnce && _hasSearched && now - _lastSearch < BGSRNReactRootSearchMinInterval) {
    return NO;
  }
  _hasSearched = YES;
  _lastSearch = now;
  return YES;
}

@end
