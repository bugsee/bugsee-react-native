#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs a codegen `emitOn*` call and reports whether it was delivered,
/// catching -- and logging -- anything it throws. Never throws itself.
///
/// The generated `emitOn*` method calls a `std::function` that is only set
/// once `getTurboModule` builds the JSI object. An event that arrives before
/// that, or after the module has been invalidated, calls an unset one, and
/// that throws `std::bad_function_call`. Objective-C's `@catch (NSException *)`
/// cannot see a C++ exception, so left unguarded it unwinds straight through
/// to `std::terminate` and takes the app down.
///
/// Caught here, inside Objective-C++, rather than converted and re-raised: the
/// callers (`BugseeModule.mm`'s sink blocks, invoked from `BGSRNEventBus` and
/// `BGSRNReportHandlerBridge`) sit under plain Objective-C frames compiled
/// without `-fobjc-arc-exceptions`, where an exception unwinding through
/// leaks every strong local. They branch on the result instead: the lifecycle
/// path drops the event (there is no subscriber to queue it for), and the
/// report path completes the waiting handle instead of leaving the SDK to wait
/// out a deadline no JS will ever meet.
///
/// @param emit The codegen `emitOn*` call, wrapped in a block. `nil` is not a
///   delivery.
/// @param what Named in the log line, so it says which emit failed.
/// @return YES if `emit` ran to completion; NO if it threw anything (an
///   `NSException`, a `std::exception`, or any other C++ throw) or was `nil`.
FOUNDATION_EXPORT BOOL BGSRNGuardedEmit(dispatch_block_t _Nullable emit, NSString *what);

NS_ASSUME_NONNULL_END
