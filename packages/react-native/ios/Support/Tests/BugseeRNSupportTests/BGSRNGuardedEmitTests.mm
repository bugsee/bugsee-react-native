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

- (void)testEmitBeforeEmitterIsSetDoesNotThrowAndIsDropped {
  std::function<void()> unset;
  __block BOOL delivered = NO;
  NSException *caught = nil;

  // The guard converts the C++ exception into an NSException rather than
  // silently swallowing it -- exactly the report path's mechanism, whose
  // caller (BGSRNReportHandlerBridge) needs to see the failure to complete
  // the waiting handle. Catching it here is what "does not throw" (past this
  // point, uncaught, all the way to std::terminate) and "is dropped" (the
  // emit's own effect never ran) actually mean for a caller of the guard.
  @try {
    BGSRNGuardedEmit(^{
      unset();
      delivered = YES;
    }, @"onLifecycleEvent");
  } @catch (NSException *exception) {
    caught = exception;
  }

  XCTAssertFalse(delivered, @"an emit through an unset emitter must be dropped, not delivered");
  XCTAssertNotNil(caught, @"the guard must report the drop as a catchable NSException, not let the "
                          @"C++ exception escape uncaught");
  XCTAssertEqualObjects(caught.name, NSInternalInconsistencyException);
}

- (void)testEmitAfterEmitterIsSetDelivers {
  std::function<void()> set = [] {
  };
  __block BOOL delivered = NO;

  XCTAssertNoThrow(BGSRNGuardedEmit(^{
    set();
    delivered = YES;
  }, @"onLifecycleEvent"));

  XCTAssertTrue(delivered, @"an emit through a set emitter must be delivered");
}

@end
