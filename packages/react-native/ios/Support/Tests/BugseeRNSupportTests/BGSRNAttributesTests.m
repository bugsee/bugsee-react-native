@import XCTest;
@import BugseeRNSupport;

/// Exercises `BGSRNAttributes` without the SDK: `setValue:forKey:setter:getter:`
/// takes the store as plain blocks, so a fake dictionary here plays the part
/// `+[Bugsee setAttribute:withValue:]`/`+[Bugsee getAttribute:]` play in
/// `BugseeModule.mm` (Task 5.3). Mirrors Android's `AttributeBridgeTest` by
/// intent where the rule is shared.
@interface BGSRNAttributesTests : XCTestCase
@end

@implementation BGSRNAttributesTests {
  NSMutableDictionary<NSString *, id> *_store;
}

- (void)setUp {
  [super setUp];
  _store = [NSMutableDictionary dictionary];
}

/// The fake `setter`: always reports success and actually stores the value --
/// the well-behaved case every "drops it anyway" test below deliberately
/// deviates from.
- (BOOL (^)(NSString *, id))storeSetter {
  NSMutableDictionary<NSString *, id> *store = _store;
  return ^BOOL(NSString *key, id value) {
    store[key] = value;
    return YES;
  };
}

/// The fake `getter`: reads straight back from the same dictionary.
- (id _Nullable (^)(NSString *))storeGetter {
  NSMutableDictionary<NSString *, id> *store = _store;
  return ^id(NSString *key) {
    return store[key];
  };
}

#pragma mark - setValue:forKey:setter:getter:

- (void)testVerifiedWhenTheStoreKeepsTheValue {
  const BOOL result = [BGSRNAttributes setValue:@"blue"
                                          forKey:@"color"
                                          setter:self.storeSetter
                                          getter:self.storeGetter];
  XCTAssertTrue(result);
  XCTAssertEqualObjects(_store[@"color"], @"blue");
}

/// iOS's size path: the setter claims success (exactly what
/// `+setAttribute:withValue:` does even when it silently drops an
/// over-the-archive-limit value), but nothing actually landed in the store.
- (void)testRejectedWhenTheSetterSaysYesButTheStoreDroppedIt {
  BOOL (^droppingSetter)(NSString *, id) = ^BOOL(NSString *key, id value) {
    return YES; // as the SDK does for a value it silently discarded
  };
  const BOOL result = [BGSRNAttributes setValue:@"blue"
                                          forKey:@"color"
                                          setter:droppingSetter
                                          getter:self.storeGetter];
  XCTAssertFalse(result);
}

- (void)testRejectedWhenTheStoreKeepsAnOlderValue {
  _store[@"color"] = @"red";
  BOOL (^staleSetter)(NSString *, id) = ^BOOL(NSString *key, id value) {
    return YES; // claims success but leaves the previous value in place
  };
  const BOOL result = [BGSRNAttributes setValue:@"blue"
                                          forKey:@"color"
                                          setter:staleSetter
                                          getter:self.storeGetter];
  XCTAssertFalse(result);
  XCTAssertEqualObjects(_store[@"color"], @"red");
}

#pragma mark - readable:

- (void)testReadableKeepsBooleansAsCFBooleans {
  NSDictionary<NSString *, id> *readable = [BGSRNAttributes readable:@{ @"flag" : BGSRNBoolNumber(YES) }];
  NSNumber *value = readable[@"flag"];
  XCTAssertEqual(CFGetTypeID((__bridge CFTypeRef)value), CFBooleanGetTypeID());
}

- (void)testReadableTurnsAStringArrayIntoAnArray {
  NSDictionary<NSString *, id> *readable = [BGSRNAttributes readable:@{ @"tags" : @[ @"a", @"b" ] }];
  XCTAssertEqualObjects(readable[@"tags"], (@[ @"a", @"b" ]));
}

- (void)testReadableDropsUnknownTypes {
  NSDictionary<NSString *, id> *readable = [BGSRNAttributes readable:@{
    @"when" : [NSDate date],
    @"blob" : [NSData data],
    @"kept" : @"value",
  }];
  XCTAssertNil(readable[@"when"]);
  XCTAssertNil(readable[@"blob"]);
  XCTAssertEqualObjects(readable[@"kept"], @"value");
  XCTAssertEqual(readable.count, (NSUInteger)1);
}

#pragma mark - identifier:

- (void)testEmptyIdentifierReadsAsAbsent {
  XCTAssertNil([BGSRNAttributes identifier:nil]);
  XCTAssertNil([BGSRNAttributes identifier:@""]);
  XCTAssertEqualObjects([BGSRNAttributes identifier:@"someone"], @"someone");
}

#pragma mark - the mirrored archive-math constant, not the SDK's observed behaviour

// These three tests pin the archive math of THIS FILE's own mirrored
// `BGSRNAttributeArchiveLimit` constant against a bare `NSKeyedArchiver`
// round trip -- they do not call through `+[Bugsee setAttribute:withValue:]`
// and so cannot observe what the real SDK actually keeps or drops.
//
// A bare ASCII `NSString` archives at `length + 286` bytes on current iOS
// Foundation (measured on both an iOS 26.5 and an iOS 18.5 simulator, with
// `NSKeyedArchiver archivedDataWithRootObject:requiringSecureCoding:NO`):
// an 800-character string measures 1086 bytes, 900 measures 1186, and 1024
// measures 1310 -- so the archive math's crossover against
// `BGSRNAttributeArchiveLimit` (1124) is around 838 ASCII characters.
// Corrected by controller ruling after Task 5.3's first pass found the
// mismatch against the design doc's originally assumed 900-1024 range.
//
// Task 5.5 then found the archive math does NOT match the real device: a
// 900-character value was KEPT by the actual `Bugsee.setAttribute`/
// `getAttribute` round trip on the published `7.0.0-beta3` binary, even
// though `testA900CharacterAsciiStringExceedsTheArchiveLimit` below still
// correctly passes (900 characters really does archive over 1124 bytes by
// this math, and the SDK source's own check does reject an archive over that
// limit) -- so the mismatch is between this math and what the binary
// actually does, not a bug in these tests. By controller ruling, the design
// doc's Phase 5 table no longer has a 900-character row (the iOS SDK team
// has been asked why); `e2e_mid` (800, kept on both) and `e2e_long` (1024,
// dropped on iOS) still pin the two ends this math and the device agree on.

/// Pins the archive math only: an 800-character ASCII string archives UNDER
/// `BGSRNAttributeArchiveLimit` (measured 1086 bytes). Matches the design
/// doc's `e2e_mid` row (kept on both platforms) -- but that agreement is
/// what Task 5.5 found does NOT hold for every length in this file's
/// predicted-safe range; see the section comment above.
- (void)testAn800CharacterAsciiStringFitsTheArchiveLimit {
  NSString *value = [@"" stringByPaddingToLength:800 withString:@"a" startingAtIndex:0];
  NSData *data = [NSKeyedArchiver archivedDataWithRootObject:value requiringSecureCoding:NO error:nil];
  XCTAssertLessThanOrEqual(data.length, (NSUInteger)BGSRNAttributeArchiveLimit);
}

/// Pins the archive math only: a 900-character ASCII string archives OVER
/// `BGSRNAttributeArchiveLimit` (measured 1186 bytes). This test passing does
/// NOT mean the real SDK rejects a 900-character value -- Task 5.5 found the
/// opposite on device (`7.0.0-beta3` keeps it); see the section comment
/// above. If this test starts failing, the archive limit or the archiving
/// method changed; that is a fact about this mirrored constant, not
/// confirmation either way about the SDK's own behaviour.
- (void)testA900CharacterAsciiStringExceedsTheArchiveLimit {
  NSString *value = [@"" stringByPaddingToLength:900 withString:@"a" startingAtIndex:0];
  NSData *data = [NSKeyedArchiver archivedDataWithRootObject:value requiringSecureCoding:NO error:nil];
  XCTAssertGreaterThan(data.length, (NSUInteger)BGSRNAttributeArchiveLimit);
}

/// Pins the archive math only: a 1024-character ASCII string archives OVER
/// `BGSRNAttributeArchiveLimit` (measured 1310 bytes). Matches the design
/// doc's `e2e_long` row, and Task 5.5 confirmed on device that iOS does
/// reject this length with `E_ATTRIBUTE_REJECTED` while Android keeps it. If
/// this test fails, the archive limit or the archiving method changed, and
/// Task 5.5's expectations must be revisited there, not patched around here.
- (void)testA1024CharacterAsciiStringExceedsTheArchiveLimit {
  NSString *value = [@"" stringByPaddingToLength:1024 withString:@"x" startingAtIndex:0];
  NSData *data = [NSKeyedArchiver archivedDataWithRootObject:value requiringSecureCoding:NO error:nil];
  XCTAssertGreaterThan(data.length, (NSUInteger)BGSRNAttributeArchiveLimit);
}

@end
