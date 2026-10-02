#import "BGSRNSpanHandles.h"

@interface BGSRNSpanEntry : NSObject
@property (nonatomic, strong) id identity;
@property (nonatomic, strong) id<BGSRNRetainedSpan> adapter;
@end

@implementation BGSRNSpanEntry
@end

@implementation BGSRNSpanHandles {
  NSMutableDictionary<NSString *, BGSRNSpanEntry *> *_byHandle;
  NSMapTable<id, NSString *> *_byIdentity;
  NSUInteger _next;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _byHandle = [NSMutableDictionary dictionary];
    _byIdentity = [NSMapTable strongToStrongObjectsMapTable];
    _next = 1;
  }
  return self;
}

- (NSString *)retainSpan:(id)span adapter:(id<BGSRNRetainedSpan>)adapter {
  if (span == nil || adapter == nil) {
    return @"";
  }
  NSString *existing = [_byIdentity objectForKey:span];
  if (existing != nil) {
    return existing;
  }
  NSString *handle = [NSString stringWithFormat:@"sp-%lu", (unsigned long)_next];
  _next += 1;
  BGSRNSpanEntry *entry = [BGSRNSpanEntry new];
  entry.identity = span;
  entry.adapter = adapter;
  _byHandle[handle] = entry;
  [_byIdentity setObject:handle forKey:span];
  return handle;
}

- (NSArray<NSString *> *)finishHandle:(NSString *)handle status:(NSNumber *)status {
  BGSRNSpanEntry *entry = handle == nil ? nil : _byHandle[handle];
  if (entry == nil) {
    return @[];
  }
  [entry.adapter bgsrnFinishWithStatus:status];
  return [self releaseFinished];
}

- (void)releaseAll {
  [_byHandle removeAllObjects];
  [_byIdentity removeAllObjects];
}

- (BOOL)containsHandle:(NSString *)handle {
  return handle != nil && _byHandle[handle] != nil;
}

- (NSUInteger)liveCount {
  return _byHandle.count;
}

- (id<BGSRNRetainedSpan>)adapterForHandle:(NSString *)handle {
  BGSRNSpanEntry *entry = handle == nil ? nil : _byHandle[handle];
  return entry.adapter;
}

/// Drops every entry whose span is finished. Order follows insertion.
- (NSArray<NSString *> *)releaseFinished {
  NSMutableArray<NSString *> *released = [NSMutableArray array];
  for (NSString *handle in _byHandle) {
    BGSRNSpanEntry *entry = _byHandle[handle];
    if ([entry.adapter bgsrnIsFinished]) {
      [released addObject:handle];
    }
  }
  for (NSString *handle in released) {
    BGSRNSpanEntry *entry = _byHandle[handle];
    [_byIdentity removeObjectForKey:entry.identity];
    [_byHandle removeObjectForKey:handle];
  }
  return released;
}

@end
