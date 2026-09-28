#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs a codegen `emitOn*` call, converting the C++ exception an unset
/// TurboModule event emitter throws into an `NSException` an Objective-C
/// `@catch` can see.
///
/// The generated `emitOn*` method calls a `std::function` that is only set
/// once `getTurboModule` builds the JSI object. An event that arrives before
/// that -- during start-up, or between a reload tearing the old module down
/// and the new one's TurboModule being built -- or after the module has
/// already been invalidated, calls an unset one, and that throws
/// `std::bad_function_call`. Objective-C's `@catch (NSException *)` cannot
/// see a C++ exception, so left unguarded it unwinds straight through to
/// `std::terminate` and takes the app down.
///
/// Shared by both emit paths (lifecycle events, through `BGSRNEventBus`, and
/// report handler requests, through `BGSRNReportHandlerBridge`) so the
/// conversion happens in exactly one place. What a dropped emit *means* still
/// differs per caller, and is left to them: the lifecycle path just logs and
/// moves on (there is no subscriber to queue the event for), while the report
/// path needs the exception to reach the bridge so it completes the waiting
/// handle instead of leaving the SDK to wait out a deadline no JS will ever
/// meet.
///
/// @param emit The codegen `emitOn*` call, wrapped in a block.
/// @param what Named in the message of the `NSException` this raises, so
///   whichever `@catch` logs it says which emit failed.
FOUNDATION_EXPORT void BGSRNGuardedEmit(dispatch_block_t emit, NSString *what);

NS_ASSUME_NONNULL_END
