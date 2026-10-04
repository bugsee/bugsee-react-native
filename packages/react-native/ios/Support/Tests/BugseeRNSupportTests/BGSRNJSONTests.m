@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

#import "BGSRNFakeReport.h"

/// The iOS half of the object transport: JSON text in, Foundation out. Mirrors
/// Android's `BridgeJsonTest` by name where the rule is shared.
///
/// The defect it exists for: React Native's TurboModule conversion of an
/// object argument (`convertJSIObjectToNSDictionary`) skips every member whose
/// value is JS `null`, unless an app-level feature flag is on. A dictionary
/// that reaches native with the key missing cannot say "clear this".
@interface BGSRNJSONTests : XCTestCase
@end

@implementation BGSRNJSONTests

- (NSDictionary *)parse:(NSString *)json {
  NSError *error = nil;
  NSDictionary *result = BGSRNJSONObject(json, &error);
  XCTAssertNotNil(result, @"rejected %@: %@", json, error);
  XCTAssertNil(error);
  return result;
}

- (void)assertBad:(NSString *_Nullable)json {
  NSError *error = nil;
  XCTAssertNil(BGSRNJSONObject(json, &error), @"accepted %@", json);
  XCTAssertNotNil(error, @"no error for %@", json);
  XCTAssertEqualObjects(error.domain, BGSRNJSONErrorDomain);
  XCTAssertGreaterThan(error.localizedDescription.length, 0u);
}

static BOOL IsCFBoolean(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL IsIntegerNumber(id value) {
  return [value isKindOfClass:NSNumber.class] && !IsCFBoolean(value) &&
         !CFNumberIsFloatType((__bridge CFNumberRef)value);
}

static BOOL IsFloatNumber(id value) {
  return [value isKindOfClass:NSNumber.class] && !IsCFBoolean(value) &&
         CFNumberIsFloatType((__bridge CFNumberRef)value);
}

#pragma mark - Null

- (void)testATopLevelNullIsKeptAsNSNull {
  NSDictionary *map = [self parse:@"{\"nil\":null,\"s\":\"x\"}"];
  XCTAssertEqualObjects(map[@"nil"], NSNull.null);
  XCTAssertEqualObjects(map[@"s"], @"x");
  XCTAssertEqual(map.count, 2u);
}

- (void)testANestedNullIsKeptInAnObjectAndInAnArray {
  NSDictionary *map = [self parse:@"{\"attributes\":{\"gone\":null},\"list\":[null,1]}"];
  XCTAssertEqualObjects(map[@"attributes"], @{ @"gone" : NSNull.null });
  XCTAssertEqualObjects(map[@"list"], (@[ NSNull.null, @1 ]));
}

#pragma mark - Numbers and booleans

/// The SDK's JSON writer prints an integer NSNumber as `3`; a float-typed one
/// holding 3 would still print `3`, but the attribute and param stores take
/// the number as given, so the type is pinned, not only the value.
- (void)testIntegralNumbersAreIntegerNumbers {
  NSDictionary *map =
      [self parse:@"{\"int\":3,\"neg\":-7,\"zero\":0,\"big\":9007199254740991,\"minSafe\":-9007199254740992}"];
  for (NSString *key in @[ @"int", @"neg", @"zero", @"big", @"minSafe" ]) {
    XCTAssertTrue(IsIntegerNumber(map[key]), @"%@ is %@ (%s)", key, [map[key] class], [map[key] objCType]);
  }
  XCTAssertEqual([map[@"int"] longLongValue], 3);
  XCTAssertEqual([map[@"neg"] longLongValue], -7);
  XCTAssertEqual([map[@"zero"] longLongValue], 0);
  XCTAssertEqual([map[@"big"] longLongValue], 9007199254740991LL);
  XCTAssertEqual([map[@"minSafe"] longLongValue], -9007199254740992LL);
}

- (void)testFractionalNumbersAreDoubles {
  NSDictionary *map = [self parse:@"{\"frac\":1.5,\"tiny\":1e-7,\"huge\":1e+300,\"neg\":-0.25}"];
  for (NSString *key in @[ @"frac", @"tiny", @"huge", @"neg" ]) {
    XCTAssertTrue(IsFloatNumber(map[key]), @"%@ is %@ (%s)", key, [map[key] class], [map[key] objCType]);
  }
  XCTAssertEqual([map[@"frac"] doubleValue], 1.5);
  XCTAssertEqual([map[@"tiny"] doubleValue], 1e-7);
  XCTAssertEqual([map[@"huge"] doubleValue], 1e300);
  XCTAssertEqual([map[@"neg"] doubleValue], -0.25);
}

/// By identity: the SDK's writer special-cases CFBoolean, and anything else
/// holding 1 prints as `1`.
- (void)testBooleansAreCFBooleans {
  NSDictionary *map = [self parse:@"{\"yes\":true,\"no\":false}"];
  XCTAssertEqual((__bridge CFBooleanRef)map[@"yes"], kCFBooleanTrue);
  XCTAssertEqual((__bridge CFBooleanRef)map[@"no"], kCFBooleanFalse);
}

/// And a number is never one: 1 and 0 must not come back as true and false.
- (void)testOneAndZeroAreNotBooleans {
  NSDictionary *map = [self parse:@"{\"one\":1,\"zero\":0}"];
  XCTAssertFalse(IsCFBoolean(map[@"one"]));
  XCTAssertFalse(IsCFBoolean(map[@"zero"]));
}

/// An integer literal past `long long` range -- what `JSON.stringify` writes
/// for 1e20 -- is not a plain NSNumber: `NSJSONSerialization` returns an
/// `NSDecimalNumber`. Pinned so the report path below is known to see one.
- (void)testAnIntegerPastLongLongRangeIsADecimalNumber {
  id big = [self parse:@"{\"n\":100000000000000000000}"][@"n"];
  XCTAssertTrue([big isKindOfClass:NSDecimalNumber.class], @"%@ (%s)", [big class], [big objCType]);
  XCTAssertFalse(IsCFBoolean(big));
  XCTAssertEqual([big doubleValue], 1e20);
}

/// ...and `BGSRNReportOps` handles it: `IsFiniteNumber` accepts it as an
/// attribute value, `WireNumber` stores it as a double (it is past 2^53, so
/// not an exact integer), and as a severity it is out of range, not a crash.
- (void)testADecimalNumberAttributeIsStoredAsADouble {
  BGSRNFakeReport *report = [BGSRNFakeReport new];
  NSError *error = nil;
  XCTAssertTrue([BGSRNReportOps applyPatchJSON:@"{\"attributes\":{\"big\":100000000000000000000}}"
                                      toReport:report
                                         error:&error],
                @"%@", error);
  id stored = report.fakeAttributes[@"big"];
  XCTAssertFalse([stored isKindOfClass:NSDecimalNumber.class], @"%@", [stored class]);
  XCTAssertTrue(IsFloatNumber(stored), @"%@ (%s)", [stored class], [stored objCType]);
  XCTAssertEqual([stored doubleValue], 1e20);

  error = nil;
  XCTAssertFalse([BGSRNReportOps applyPatchJSON:@"{\"severity\":100000000000000000000}"
                                       toReport:report
                                          error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
}

#pragma mark - Lone surrogates

/// Why `encodeBridgeObject` replaces lone surrogates in JS: `JSON.stringify`
/// escapes one as `\ud800`, and `NSJSONSerialization` rejects the WHOLE text
/// for it. Unnormalised, a summary cut mid-emoji rejected on iOS alone.
- (void)testNSJSONSerializationRejectsALoneSurrogateEscape {
  [self assertBad:@"{\"s\":\"\\ud800\"}"];
  [self assertBad:@"{\"s\":\"a\\udc00b\"}"];
}

/// What JS sends instead -- U+FFFD, raw or escaped -- and a valid escaped pair, parse.
- (void)testTheReplacementCharacterAndAValidPairParse {
  XCTAssertEqualObjects([self parse:@"{\"s\":\"a\uFFFD\"}"][@"s"], @"a\uFFFD");
  XCTAssertEqualObjects([self parse:@"{\"s\":\"a\\ufffd\"}"][@"s"], @"a\uFFFD");
  XCTAssertEqualObjects([self parse:@"{\"s\":\"\\ud83d\\ude00\"}"][@"s"], @"\U0001F600");
}

#pragma mark - Structure

- (void)testNestedArraysAndObjectsBecomeArraysAndDictionaries {
  NSDictionary *map = [self
      parse:@"{\"nested\":{\"list\":[1,\"two\",{\"deep\":false},[true]],\"empty\":{}},\"none\":[]}"];
  NSArray *list = map[@"nested"][@"list"];
  XCTAssertEqualObjects(list[0], @1);
  XCTAssertEqualObjects(list[1], @"two");
  XCTAssertEqualObjects(list[2], @{ @"deep" : @NO });
  XCTAssertEqualObjects(list[3], @[ @YES ]);
  XCTAssertEqualObjects(map[@"nested"][@"empty"], @{});
  XCTAssertEqualObjects(map[@"none"], @[]);
}

- (void)testStringsAreUnescaped {
  XCTAssertEqualObjects([self parse:@"{\"s\":\"a\\\"b\\\\c\\nd\\u00e9\"}"][@"s"], @"a\"b\\c\ndé");
}

- (void)testProtoIsAnOrdinaryKey {
  XCTAssertEqualObjects([self parse:@"{\"__proto__\":\"x\"}"][@"__proto__"], @"x");
}

- (void)testAnEmptyObjectIsAnEmptyDictionary {
  XCTAssertEqualObjects([self parse:@"{}"], @{});
  XCTAssertEqualObjects([self parse:@"  {}\n"], @{});
}

#pragma mark - Bad input

- (void)testMalformedJsonIsBad {
  [self assertBad:@"{\"a\":"];
  [self assertBad:@"{\"a\" 1}"];
  [self assertBad:@""];
  [self assertBad:@"   "];
}

- (void)testAnythingButAnObjectIsBad {
  [self assertBad:@"[1,2]"];
  [self assertBad:@"\"s\""];
  [self assertBad:@"3"];
  [self assertBad:@"null"];
  [self assertBad:@"true"];
  [self assertBad:@"not json"];
}

- (void)testTrailingTextAfterTheObjectIsBad {
  [self assertBad:@"{\"a\":1} x"];
  [self assertBad:@"{\"a\":1}{}"];
}

- (void)testANilStringIsBad {
  [self assertBad:nil];
}

/// A NULL error out-parameter is allowed, as everywhere in Foundation.
- (void)testANullErrorPointerIsAllowed {
  XCTAssertNil(BGSRNJSONObject(@"[", NULL));
  XCTAssertEqualObjects(BGSRNJSONObject(@"{}", NULL), @{});
}

#pragma mark - The report patch, end to end

/// `reportUpdate` as it now arrives: JSON text. The three edits the object
/// conversion dropped -- a null summary, a null description, a null
/// attribute -- all take effect.
- (void)testAParsedPatchClearsAndRemoves {
  BGSRNFakeReport *report = [BGSRNFakeReport new];
  report.fakeSummary = @"old summary";
  report.fakeDescription = @"old description";
  report.fakeAttributes[@"gone"] = @"value";
  report.fakeAttributes[@"kept"] = @"value";

  NSError *error = nil;
  XCTAssertTrue([BGSRNReportOps applyPatchJSON:@"{\"summary\":null,\"description\":null,"
                                               @"\"attributes\":{\"gone\":null,\"count\":3}}"
                                      toReport:report
                                         error:&error],
                @"%@", error);
  XCTAssertNil(error);
  XCTAssertNil(report.fakeSummary);
  XCTAssertNil(report.fakeDescription);
  XCTAssertNil(report.fakeAttributes[@"gone"]);
  XCTAssertEqualObjects(report.fakeAttributes[@"kept"], @"value");
  XCTAssertEqualObjects(report.fakeAttributes[@"count"], @3);
  XCTAssertTrue([report.mutations containsObject:@"removeAttributeForName:"]);
}

/// Text that is not a JSON object is a bad argument, and touches nothing.
- (void)testMalformedPatchJsonIsABadArgument {
  BGSRNFakeReport *report = [BGSRNFakeReport new];
  report.fakeSummary = @"old summary";
  for (NSString *json in @[ @"{\"summary\":", @"[]", @"" ]) {
    NSError *error = nil;
    XCTAssertFalse([BGSRNReportOps applyPatchJSON:json toReport:report error:&error], @"accepted %@", json);
    XCTAssertEqualObjects(error.domain, BGSRNReportErrorDomain);
    XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
    XCTAssertEqualObjects(BGSRNReportErrorWireCode(error), @"E_REPORT_BAD_ARGUMENT");
  }
  XCTAssertEqualObjects(report.fakeSummary, @"old summary");
  XCTAssertEqualObjects(report.mutations, @[]);
}

/// Parsing does not bypass validation: a bad field still applies nothing.
- (void)testAParsedPatchIsStillAllOrNothing {
  BGSRNFakeReport *report = [BGSRNFakeReport new];
  report.fakeSummary = @"old summary";
  NSError *error = nil;
  XCTAssertFalse([BGSRNReportOps applyPatchJSON:@"{\"summary\":null,\"attributes\":{\"gone\":null},\"severity\":0}"
                                       toReport:report
                                          error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
  XCTAssertEqualObjects(report.fakeSummary, @"old summary");
  XCTAssertEqualObjects(report.mutations, @[]);
}

/// The system parser's own diagnostic can repeat fragments of the text it
/// choked on; the message is fixed instead.
- (void)testMalformedTextIsAFixedMessage {
  NSError *error = nil;
  XCTAssertNil(BGSRNJSONObject(@"{\"a\": \"s3cret", &error));
  XCTAssertEqualObjects(error.localizedDescription, @"malformed JSON");
}

@end
