@import XCTest;
@import BugseeRNSupport;

/// Pins `BGSRNFilterArming`: after a JS reload the previous module's JS
/// armed a filter, the new module's has not, and the filter must drop.
@interface BGSRNFilterArmingTests : XCTestCase
@end

@implementation BGSRNFilterArmingTests

- (void)testNothingIsArmedUntilJsArms {
  BGSRNFilterArming *arming = [BGSRNFilterArming new];
  NSObject *module = [NSObject new];
  XCTAssertFalse([arming isArmedFor:module]);
  XCTAssertFalse([arming isArmedFor:nil]);
}

- (void)testArmedForTheModuleThatArmed {
  BGSRNFilterArming *arming = [BGSRNFilterArming new];
  NSObject *module = [NSObject new];
  [arming armFor:module];
  XCTAssertTrue([arming isArmedFor:module]);
}

- (void)testANewModuleIsNotArmedByTheOldOne {
  BGSRNFilterArming *arming = [BGSRNFilterArming new];
  NSObject *oldModule = [NSObject new];
  NSObject *newModule = [NSObject new];
  [arming armFor:oldModule];
  XCTAssertFalse([arming isArmedFor:newModule]);
  [arming armFor:newModule];
  XCTAssertTrue([arming isArmedFor:newModule]);
  XCTAssertFalse([arming isArmedFor:oldModule]);
}

- (void)testAReleasedOwnerIsNotArmed {
  BGSRNFilterArming *arming = [BGSRNFilterArming new];
  NSObject *replacement = [NSObject new];
  @autoreleasepool {
    NSObject *gone = [NSObject new];
    [arming armFor:gone];
    XCTAssertTrue([arming isArmedFor:gone]);
  }
  XCTAssertFalse([arming isArmedFor:replacement]);
  XCTAssertFalse([arming isArmedFor:nil]);
}

@end
