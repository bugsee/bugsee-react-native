@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// Pins the iOS half of the exception-options wire shape and the backend
/// exception name contract. Mirrors the brief's case names.
@interface BGSRNExceptionsTests : XCTestCase
@end

@implementation BGSRNExceptionsTests

- (BGSRNExceptionOptions *)optionsFrom:(NSString *_Nullable)json {
  NSError *error = nil;
  BGSRNExceptionOptions *opts = [BGSRNExceptions loggingOptionsFromJSON:json error:&error];
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

- (void)testDomainIsKept {
  BGSRNExceptionOptions *opts = [self optionsFrom:@"{\"domain\":\"auth\"}"];
  XCTAssertEqualObjects(opts.domain, @"auth");
}

- (void)testIncludeVideoDefaultsToYes {
  BGSRNExceptionOptions *empty = [self optionsFrom:@"{}"];
  XCTAssertTrue(empty.includeVideo, @"the wire default is YES");

  BGSRNExceptionOptions *domainOnly = [self optionsFrom:@"{\"domain\":\"x\"}"];
  XCTAssertTrue(domainOnly.includeVideo);
}

- (void)testIncludeVideoFalseIsKept {
  BGSRNExceptionOptions *opts = [self optionsFrom:@"{\"includeVideo\":false}"];
  XCTAssertFalse(opts.includeVideo);
}

- (void)testLabelsAreKept {
  BGSRNExceptionOptions *opts = [self optionsFrom:@"{\"labels\":[\"a\",\"b\"]}"];
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
  BGSRNExceptionOptions *opts =
      [self optionsFrom:@"{\"domain\":\"d\",\"skipFrames\":2,\"mergingRules\":{},\"extra\":true}"];
  XCTAssertEqualObjects(opts.domain, @"d");
  XCTAssertTrue(opts.includeVideo);
  XCTAssertNil(opts.labels);
  }

/// Malformed options say so in the bridge's own words, never the system
/// parser's, which can repeat the text it choked on.
- (void)testMalformedOptionsAreTheBridgesOwnMessage {
  NSError *error = nil;
  XCTAssertNil([BGSRNExceptions loggingOptionsFromJSON:@"{\"domain\": \"s3cret" error:&error]);
  XCTAssertEqualObjects(BGSRNErrorMessage(error), @"exception options are not a JSON object: malformed JSON");
}

@end
