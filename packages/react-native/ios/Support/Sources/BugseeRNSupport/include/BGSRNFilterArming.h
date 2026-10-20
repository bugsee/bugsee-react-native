#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Which module's JS has installed a filter.
///
/// The native filter blocks and their flags are process statics, so they
/// outlive a JavaScript reload. The new module attaches as the sink, but its
/// JS has not subscribed, and a request emitted to it would never be
/// answered: on iOS it stays pending until process death. A filter block
/// therefore asks `isArmedFor:` with the current module and drops at once
/// when this returns NO.
///
/// The owner is held weakly: an invalidated module that is released reads as
/// not armed. Thread-safe: the SDK calls filters from any thread.
@interface BGSRNFilterArming : NSObject

/// `owner`'s JS has installed the filter. Replaces any earlier owner.
- (void)armFor:(id)owner;

/// YES only when `owner` is the module that last called `armFor:`.
- (BOOL)isArmedFor:(nullable id)owner;

@end

NS_ASSUME_NONNULL_END
