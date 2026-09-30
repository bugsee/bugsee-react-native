@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// Pins the iOS half of the exception-options wire shape and the backend
/// exception name contract. Mirrors the brief's case names.
@interface BGSRNExceptionsTests : XCTestCase
@end

@implementation BGSRNExceptionsTests

- (BugseeExceptionLoggingOptions *)optionsFrom:(NSString *_Nullable)json {
  NSError *error = nil;
  BugseeExceptionLoggingOptions *opts = [BGSRNExceptions loggingOptionsFromJSON:json error:&error];
  XCTAssertNotNil(opts, @"rejected %@: %@", json, error);
  XCTAssertNil(error);
  return opts;
}

- (void)assertBad:(NSString *_Nullable)json {
  NSError *error = nil;
  XCTAssertNil([BGSRNExceptions loggingOptionsFromJSON:json error:&error], @"accepted %@", json);
  XCTAssertNotNil(error, @"no error for %@", json);
  XCTAssertEqualObjects(error.domain, BGSRNExceptionsErrorDomain);
}

- (void)testTheNameIsTheBackendContract {
  XCTAssertEqualObjects(BGSRNReactNativeExceptionName, @"ReactNativeWebException");
}

- (void)testDomainBecomesExceptionDomain {
  BugseeExceptionLoggingOptions *opts = [self optionsFrom:@"{\"domain\":\"auth\"}"];
  XCTAssertEqualObjects(opts.exceptionDomain, @"auth");
}

- (void)testIncludeVideoDefaultsToYes {
  BugseeExceptionLoggingOptions *empty = [self optionsFrom:@"{}"];
  XCTAssertTrue(empty.includeVideo, @"SDK defaults to NO; the wrapper must force YES");

  BugseeExceptionLoggingOptions *domainOnly = [self optionsFrom:@"{\"domain\":\"x\"}"];
  XCTAssertTrue(domainOnly.includeVideo);
}

- (void)testIncludeVideoFalseIsKept {
  BugseeExceptionLoggingOptions *opts = [self optionsFrom:@"{\"includeVideo\":false}"];
  XCTAssertFalse(opts.includeVideo);
}

- (void)testLabelsAreKept {
  BugseeExceptionLoggingOptions *opts = [self optionsFrom:@"{\"labels\":[\"a\",\"b\"]}"];
  XCTAssertEqualObjects(opts.labels, (@[ @"a", @"b" ]));
}

- (void)testNilJsonIsNilOptions {
  NSError *error = nil;
  XCTAssertNil([BGSRNExceptions loggingOptionsFromJSON:nil error:&error]);
  XCTAssertNil(error, @"nil text is not an error; it is no options");
}

- (void)testUnparseableJsonIsAnError {
  [self assertBad:@"{\"domain\":"];
  [self assertBad:@"[]"];
  [self assertBad:@"\"s\""];
  [self assertBad:@""];
  [self assertBad:@"not json"];
}

- (void)testANonStringLabelIsAnError {
  [self assertBad:@"{\"labels\":[\"a\",1]}"];
  [self assertBad:@"{\"labels\":\"a\"}"];
  [self assertBad:@"{\"domain\":3}"];
  [self assertBad:@"{\"includeVideo\":1}"];
}

- (void)testUnknownKeysAreIgnored {
  BugseeExceptionLoggingOptions *opts =
      [self optionsFrom:@"{\"domain\":\"d\",\"skipFrames\":2,\"mergingRules\":{},\"extra\":true}"];
  XCTAssertEqualObjects(opts.exceptionDomain, @"d");
  XCTAssertTrue(opts.includeVideo);
  XCTAssertNil(opts.labels);
  XCTAssertNil(opts.mergingRules);
}

@end
