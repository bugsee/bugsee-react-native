#import "BGSRNSpanHandles.h"

#import <os/lock.h>

@interface BGSRNSpanEntry : NSObject
@property (nonatomic, strong) id identity;
@property (nonatomic, strong) id<BGSRNRetainedSpan> adapter;
@end

@implementation BGSRNSpanEntry
@end

@implementation BGSRNSpanHandles {
  os_unfair_lock _lock;
  BOOL _closed;
  NSMutableDictionary<NSString *, BGSRNSpanEntry *> *_byHandle;
  NSMapTable<id, NSString *> *_byIdentity;
  NSUInteger _next;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _lock = OS_UNFAIR_LOCK_INIT;
    _byHandle = [NSMutableDictionary dictionary];
    _byIdentity = [NSMapTable strongToStrongObjectsMapTable];
    _next = 1;
  }
  return self;
}

/// After invalidate. `retainSpan` stores nothing.
+ (BGSRNSpanHandles *)closedRegistry {
  static BGSRNSpanHandles *closed;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    closed = [self new];
    closed->_closed = YES;
  });
  return closed;
}

- (NSString *)retainSpan:(id)span adapter:(id<BGSRNRetainedSpan>)adapter {
  os_unfair_lock_lock(&_lock);
  NSString *handle = @"";
  if (!_closed && span != nil && adapter != nil) {
    NSString *existing = [_byIdentity objectForKey:span];
    if (existing != nil) {
      handle = existing;
    } else {
      handle = [NSString stringWithFormat:@"sp-%lu", (unsigned long)_next];
      _next += 1;
      BGSRNSpanEntry *entry = [BGSRNSpanEntry new];
      entry.identity = span;
      entry.adapter = adapter;
      _byHandle[handle] = entry;
      [_byIdentity setObject:handle forKey:span];
    }
  }
  os_unfair_lock_unlock(&_lock);
  return handle;
}

- (NSArray<NSString *> *)finishHandle:(NSString *)handle status:(NSNumber *)status {
  // The adapter's finish is outside the lock: os_unfair_lock does not
  // re-enter, and a parent finish runs the child's finish on this thread.
  os_unfair_lock_lock(&_lock);
  BGSRNSpanEntry *entry = (_closed || handle == nil) ? nil : _byHandle[handle];
  id<BGSRNRetainedSpan> adapter = entry.adapter;
  os_unfair_lock_unlock(&_lock);
  if (adapter == nil) {
    return @[];
  }
  [adapter bgsrnFinishWithStatus:status];
  os_unfair_lock_lock(&_lock);
  NSArray<NSString *> *released = _closed ? @[] : [self dropCalled:handle];
  os_unfair_lock_unlock(&_lock);
  return released;
}

- (void)releaseAll {
  os_unfair_lock_lock(&_lock);
  _closed = YES;
  [_byHandle removeAllObjects];
  [_byIdentity removeAllObjects];
  os_unfair_lock_unlock(&_lock);
}

- (BOOL)containsHandle:(NSString *)handle {
  os_unfair_lock_lock(&_lock);
  const BOOL contains = handle != nil && _byHandle[handle] != nil;
  os_unfair_lock_unlock(&_lock);
  return contains;
}

- (NSUInteger)liveCount {
  os_unfair_lock_lock(&_lock);
  const NSUInteger count = _byHandle.count;
  os_unfair_lock_unlock(&_lock);
  return count;
}

- (id<BGSRNRetainedSpan>)adapterForHandle:(NSString *)handle {
  os_unfair_lock_lock(&_lock);
  BGSRNSpanEntry *entry = (_closed || handle == nil) ? nil : _byHandle[handle];
  id<BGSRNRetainedSpan> adapter = entry.adapter;
  os_unfair_lock_unlock(&_lock);
  return adapter;
}

/// Caller holds the lock. `called` is removed whether or not it reports finished.
- (NSArray<NSString *> *)dropCalled:(NSString *)called {
  NSMutableArray<NSString *> *released = [NSMutableArray array];
  BGSRNSpanEntry *calledEntry = called == nil ? nil : _byHandle[called];
  if (calledEntry != nil) {
    [_byIdentity removeObjectForKey:calledEntry.identity];
    [_byHandle removeObjectForKey:called];
    [released addObject:called];
  }
  NSMutableArray<NSString *> *finished = [NSMutableArray array];
  for (NSString *handle in _byHandle) {
    BGSRNSpanEntry *entry = _byHandle[handle];
    if ([entry.adapter bgsrnIsFinished]) {
      [finished addObject:handle];
    }
  }
  for (NSString *handle in finished) {
    BGSRNSpanEntry *entry = _byHandle[handle];
    [_byIdentity removeObjectForKey:entry.identity];
    [_byHandle removeObjectForKey:handle];
    [released addObject:handle];
  }
  return released;
}

@end
