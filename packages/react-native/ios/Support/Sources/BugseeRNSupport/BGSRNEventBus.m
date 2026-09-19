#import "BGSRNEventBus.h"

static NSString *const kLifecyclePrefix = @"com.bugsee.lifecycle.";

@implementation BGSRNEventBus {
  /// Weak: the bridge owns the module, and holding it here would keep a torn
  /// down instance alive for the life of the process.
  __weak id _sink;
  void (^_block)(NSString *, NSString *_Nullable);
  /// The SDK dispatches from its own threads while the bridge attaches and
  /// detaches from the React thread.
  NSLock *_lock;
}

+ (BGSRNEventBus *)shared {
  static BGSRNEventBus *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ shared = [[BGSRNEventBus alloc] init]; });
  return shared;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _lock = [[NSLock alloc] init];
  }
  return self;
}

- (void)attach:(id)sink block:(void (^)(NSString *, NSString *_Nullable))block {
  [_lock lock];
  _sink = sink;
  _block = [block copy];
  [_lock unlock];
}

- (void)detach:(id)sink {
  [_lock lock];
  if (_sink == sink) {
    _sink = nil;
    _block = nil;
  }
  [_lock unlock];
}

- (void)emitLifecycle:(NSString *)rawName reportId:(NSString *)reportId {
  [_lock lock];
  // Copied under the lock and invoked outside it: a handler that calls back
  // into the bus would otherwise deadlock on a non-recursive lock.
  void (^block)(NSString *, NSString *_Nullable) = _block;
  const BOOL alive = _sink != nil;
  [_lock unlock];

  if (block == nil || !alive) {
    return;
  }

  NSString *name = [rawName hasPrefix:kLifecyclePrefix]
      ? [rawName substringFromIndex:kLifecyclePrefix.length]
      : rawName;

  @try {
    block(name, reportId);
  } @catch (NSException *exception) {
    // This runs on the SDK's dispatch thread. Letting a dead bridge's
    // exception escape would break the SDK's own lifecycle handling for a
    // fault that is entirely ours.
    NSLog(@"[Bugsee] failed to deliver lifecycle event %@: %@", name, exception);
  }
}

@end
