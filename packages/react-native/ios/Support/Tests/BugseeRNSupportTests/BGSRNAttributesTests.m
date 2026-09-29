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

#pragma mark - the archive-limit facts Task 5.5 depends on

// A bare ASCII `NSString` archives at `length + 286` bytes on current iOS
// Foundation (measured on both an iOS 26.5 and an iOS 18.5 simulator, with
// `NSKeyedArchiver archivedDataWithRootObject:requiringSecureCoding:NO`):
// an 800-character string measures 1086 bytes, 900 measures 1186, and 1024
// measures 1310 -- so the real crossover against `BGSRNAttributeArchiveLimit`
// (1124) is around 838 ASCII characters, not the 900-1024 range originally
// assumed. Corrected by controller ruling after Task 5.3's first pass found
// the mismatch; the design doc's Phase 5 verified facts and the Task 5.4/5.5
// table were updated to match (`e2e_mid` is now 800 chars, and a new
// `e2e_900` row pins the 900-char rejection).

/// The design doc's `e2e_mid` row: an 800-character ASCII string archives
/// UNDER the limit (measured 1086 bytes), so it resolves on iOS the same as
/// on Android.
- (void)testAn800CharacterAsciiStringFitsTheArchiveLimit {
  NSString *value = [@"" stringByPaddingToLength:800 withString:@"a" startingAtIndex:0];
  NSData *data = [NSKeyedArchiver archivedDataWithRootObject:value requiringSecureCoding:NO error:nil];
  XCTAssertLessThanOrEqual(data.length, (NSUInteger)BGSRNAttributeArchiveLimit);
}

/// The design doc's `e2e_900` row: a 900-character ASCII string -- accepted
/// on Android -- archives OVER the limit (measured 1186 bytes), so iOS
/// rejects it with `E_ATTRIBUTE_REJECTED`. If this fails, the archive limit
/// or the archiving method changed, and Task 5.5's expectations must be
/// revisited there, not patched around here.
- (void)testA900CharacterAsciiStringExceedsTheArchiveLimit {
  NSString *value = [@"" stringByPaddingToLength:900 withString:@"a" startingAtIndex:0];
  NSData *data = [NSKeyedArchiver archivedDataWithRootObject:value requiringSecureCoding:NO error:nil];
  XCTAssertGreaterThan(data.length, (NSUInteger)BGSRNAttributeArchiveLimit);
}

/// The design doc's `e2e_long` row: a 1024-character ASCII string -- accepted
/// on Android -- archives OVER the limit (measured 1310 bytes), so iOS
/// rejects it with `E_ATTRIBUTE_REJECTED`. If this fails, the archive limit
/// or the archiving method changed, and Task 5.5's expectations must be
/// revisited there, not patched around here.
- (void)testA1024CharacterAsciiStringExceedsTheArchiveLimit {
  NSString *value = [@"" stringByPaddingToLength:1024 withString:@"x" startingAtIndex:0];
  NSData *data = [NSKeyedArchiver archivedDataWithRootObject:value requiringSecureCoding:NO error:nil];
  XCTAssertGreaterThan(data.length, (NSUInteger)BGSRNAttributeArchiveLimit);
}

@end
