#import "BGSRNFilterArming.h"

@implementation BGSRNFilterArming {
  __weak id _owner;
}

- (void)armFor:(id)owner {
  @synchronized (self) {
    _owner = owner;
  }
}

- (BOOL)isArmedFor:(id)owner {
  if (owner == nil) {
    return NO;
  }
  @synchronized (self) {
    return _owner == owner;
  }
}

@end
