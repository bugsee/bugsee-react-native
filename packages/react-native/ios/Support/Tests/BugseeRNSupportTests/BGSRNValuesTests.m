@import XCTest;
@import BugseeRNSupport;

/// `+[Bugsee trace:value:]` boxed booleans must serialise as JSON booleans,
/// not as `0`/`1` numbers -- the SDK's JSON writer decides that by object
/// identity (`CFGetTypeID`), not by value, so these pin identity rather than
/// just the boolean value.
@interface BGSRNValuesTests : XCTestCase
@end

@implementation BGSRNValuesTests

- (void)testTrueIsTheCFBooleanSingleton {
  NSNumber *value = BGSRNBoolNumber(YES);
  XCTAssertEqual((__bridge CFBooleanRef)value, kCFBooleanTrue);
}

- (void)testFalseIsTheCFBooleanSingleton {
  NSNumber *value = BGSRNBoolNumber(NO);
  XCTAssertEqual((__bridge CFBooleanRef)value, kCFBooleanFalse);
}

/// The failure mode a plain `@((int)value)` boxing produces: a `Boolean`
/// number is indistinguishable from an `NSCFNumber`/integer to anything that
/// only checks value, which is exactly what the SDK's writer does not do --
/// it checks the CoreFoundation type ID.
- (void)testABoolNumberIsNotAnInteger {
  NSNumber *value = BGSRNBoolNumber(YES);
  XCTAssertEqual(CFGetTypeID((__bridge CFTypeRef)value), CFBooleanGetTypeID());
}

@end
