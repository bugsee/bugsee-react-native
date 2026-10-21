#import "BGSRNSpanHandles.h"

#import <os/lock.h>

@interface BGSRNSpanEntry : NSObject
@property (nonatomic, strong) id identity;
@property (nonatomic, strong) id<BGSRNRetainedSpan> adapter;
@property (nonatomic) BOOL owned;
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
  return [self retainSpan:span adapter:adapter owned:YES];
}

- (NSString *)retainSpan:(id)span adapter:(id<BGSRNRetainedSpan>)adapter owned:(BOOL)owned {
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
      entry.owned = owned;
      _byHandle[handle] = entry;
      [_byIdentity setObject:handle forKey:span];
    }
  }
  os_unfair_lock_unlock(&_lock);
  return handle;
}

- (NSArray<NSDictionary *> *)finishHandle:(NSString *)handle status:(NSNumber *)status {
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
  NSArray<NSDictionary *> *released = _closed ? @[] : [self dropCalled:handle];
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

- (void)cancelOpenAndReleaseAll {
  os_unfair_lock_lock(&_lock);
  NSArray<NSString *> *handles = [_byHandle.allKeys sortedArrayUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
    NSComparisonResult byLength = [@(a.length) compare:@(b.length)];
    return byLength != NSOrderedSame ? byLength : [a compare:b];
  }];
  NSMutableArray<id<BGSRNRetainedSpan>> *owned = [NSMutableArray array];
  for (NSString *handle in handles) {
    BGSRNSpanEntry *entry = _byHandle[handle];
    if (entry.owned) {
      [owned addObject:entry.adapter];
    }
  }
  _closed = YES;
  [_byHandle removeAllObjects];
  [_byIdentity removeAllObjects];
  os_unfair_lock_unlock(&_lock);
  for (id<BGSRNRetainedSpan> adapter in owned) {
    @try {
      if (![adapter bgsrnIsFinished]) {
        [adapter bgsrnFinishWithStatus:@(3)];
      }
    } @catch (NSException *exception) {
      // One span the SDK refuses must not strand the others.
    }
  }
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
- (NSArray<NSDictionary *> *)dropCalled:(NSString *)called {
  NSMutableArray<NSDictionary *> *released = [NSMutableArray array];
  BGSRNSpanEntry *calledEntry = called == nil ? nil : _byHandle[called];
  if (calledEntry != nil) {
    [_byIdentity removeObjectForKey:calledEntry.identity];
    [_byHandle removeObjectForKey:called];
    [released addObject:@{@"handle": called, @"status": @([calledEntry.adapter bgsrnStatus])}];
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
    [released addObject:@{@"handle": handle, @"status": @([entry.adapter bgsrnStatus])}];
  }
  return released;
}

@end
