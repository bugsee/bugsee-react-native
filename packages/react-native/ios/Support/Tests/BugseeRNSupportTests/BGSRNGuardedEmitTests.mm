// Not `@import`: this file is Objective-C++, and neither delivery path turns
// on C++ modules -- see BugseeModule.mm for the same note.
#import <XCTest/XCTest.h>
#import "BGSRNGuardedEmit.h"

#include <functional>

/// The defect this guards: the codegen `emitOn*` call is backed by a
/// `std::function` that is unset until the TurboModule's JSI object is built.
/// Calling an unset one throws `std::bad_function_call`, a C++ exception that
/// Objective-C's `@catch (NSException *)` cannot see -- left unguarded it
/// unwinds straight through to `std::terminate`.
///
/// `std::function<void()>` stands in for the codegen emitter here: this
/// package has no TurboModule spec of its own to build a real one against,
/// and an unset `std::function` throws the identical exception a real unset
/// emitter does.
@interface BGSRNGuardedEmitTests : XCTestCase
@end

@implementation BGSRNGuardedEmitTests

- (void)testEmitBeforeEmitterIsSetReturnsNoWithoutThrowingAndIsDropped {
  std::function<void()> unset;
  __block BOOL delivered = NO;
  __block BOOL result = YES;

  // The guard catches INSIDE this Objective-C++ file and reports the drop as
  // NO. Nothing may unwind out of it: its callers are plain Objective-C,
  // compiled without -fobjc-arc-exceptions, where an exception passing
  // through a frame leaks every strong local in it.
  XCTAssertNoThrow(result = BGSRNGuardedEmit(^{
    unset();
    delivered = YES;
  }, @"onLifecycleEvent"));

  XCTAssertFalse(result, @"an emit through an unset emitter must report failure");
  XCTAssertFalse(delivered, @"an emit through an unset emitter must be dropped, not delivered");
}

/// Not every C++ throw is a `std::exception`: a JSI or codegen path can throw
/// anything, and a `catch (const std::exception &)` alone lets the rest
/// unwind to `std::terminate`.
- (void)testANonStdExceptionIsGuardedToo {
  __block BOOL result = YES;

  XCTAssertNoThrow(result = BGSRNGuardedEmit(^{
    throw 42;
  }, @"onReportHandlerRequest"));

  XCTAssertFalse(result);
}

/// An Objective-C exception from the emit (a payload that cannot convert)
/// must not unwind into the Objective-C caller either.
- (void)testAnNSExceptionIsGuarded {
  __block BOOL result = YES;

  XCTAssertNoThrow(result = BGSRNGuardedEmit(^{
    [NSException raise:NSInvalidArgumentException format:@"cannot convert"];
  }, @"onLifecycleEvent"));

  XCTAssertFalse(result);
}

- (void)testEmitAfterEmitterIsSetDeliversAndReturnsYes {
  std::function<void()> set = [] {
  };
  __block BOOL delivered = NO;
  __block BOOL result = NO;

  XCTAssertNoThrow(result = BGSRNGuardedEmit(^{
    set();
    delivered = YES;
  }, @"onLifecycleEvent"));

  XCTAssertTrue(result);
  XCTAssertTrue(delivered, @"an emit through a set emitter must be delivered");
}

- (void)testNoEmitIsNotADelivery {
  XCTAssertFalse(BGSRNGuardedEmit(nil, @"onLifecycleEvent"));
}

@end
