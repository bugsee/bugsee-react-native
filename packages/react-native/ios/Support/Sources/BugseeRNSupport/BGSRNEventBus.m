#import "BGSRNEventBus.h"

static NSString *const kLifecyclePrefix = @"com.bugsee.lifecycle.";

@implementation BGSRNEventBus {
  /// Weak: the bridge owns the module, and holding it here would keep a torn
  /// down instance alive for the life of the process.
  __weak id _sink;
  BGSRNLifecycleBlock _block;
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

- (void)attach:(id)sink block:(BGSRNLifecycleBlock)block {
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
  BGSRNLifecycleBlock block = _block;
  const BOOL alive = _sink != nil;
  [_lock unlock];

  if (block == nil || !alive) {
    return;
  }

  NSString *name = [rawName hasPrefix:kLifecyclePrefix]
      ? [rawName substringFromIndex:kLifecyclePrefix.length]
      : rawName;

  // Branch on the result, never @try: the block catches inside Objective-C++
  // (BGSRNGuardedEmit), and nothing may unwind through this ARC file, which
  // is not built exception-safe. This runs on the SDK's dispatch thread.
  if (!block(name, reportId)) {
    NSLog(@"[Bugsee] failed to deliver lifecycle event %@", name);
  }
}

@end
