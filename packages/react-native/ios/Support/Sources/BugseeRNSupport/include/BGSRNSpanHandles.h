#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * The little surface the registry needs from a span. The module adapts
 * `id<BGSSpan>` to this so the registry, and its leak test, do not import
 * the SDK's span type.
 */
@protocol BGSRNRetainedSpan <NSObject>
/// `status` nil is the no-arg finish.
- (void)bgsrnFinishWithStatus:(NSNumber *_Nullable)status;
- (BOOL)bgsrnIsFinished;
@end

/**
 * The spans the bridge is holding onto.
 *
 * A span is an object with a lifetime. This registry is the strong
 * reference that would leak it: `finishHandle` calls through to the span
 * and then drops that handle even when it still reports unfinished, plus
 * any other span that now reports finished. `liveCount` and `containsHandle` are what the
 * tests assert, so a finish that forgets to remove the entry fails them.
 */
@interface BGSRNSpanHandles : NSObject

/// Holds `adapter` for `span`. The same `span` returns the handle already
/// issued and does not store `adapter` again.
- (NSString *)retainSpan:(id)span adapter:(id<BGSRNRetainedSpan>)adapter;

/// Finishes `handle`, then drops that handle even when it still reports
/// unfinished. Other retained spans are dropped only when they now report
/// finished. Empty when `handle` is not held.
- (NSArray<NSString *> *)finishHandle:(NSString *)handle
                               status:(NSNumber *_Nullable)status;

/// Drops every handle and refuses later retains. Does not finish the spans.
- (void)releaseAll;

/// The registry `invalidate` hands out. It retains nothing.
+ (BGSRNSpanHandles *)closedRegistry;

- (BOOL)containsHandle:(NSString *)handle;
- (NSUInteger)liveCount;
- (nullable id<BGSRNRetainedSpan>)adapterForHandle:(NSString *)handle;

@end

NS_ASSUME_NONNULL_END
