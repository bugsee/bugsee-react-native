@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// `BGSRNErrorMessage` is the one place the bridge reads an `NSError`'s
/// message. It hands back the bridge's OWN messages -- built from fixed text
/// and identifiers only -- and never a foreign error's, whose text can carry
/// anything (a system parser echoes the malformed input, a file error names
/// the path).
@interface BGSRNErrorMessageTests : XCTestCase
@end

@implementation BGSRNErrorMessageTests

static NSError *ErrorIn(NSErrorDomain domain, NSString *message) {
  return [NSError errorWithDomain:domain code:1 userInfo:@{NSLocalizedDescriptionKey : message}];
}

- (void)testPassesTheBridgesOwnMessagesThrough {
  XCTAssertEqualObjects(BGSRNErrorMessage(ErrorIn(BGSRNReportErrorDomain, @"labels must all be strings")),
                        @"labels must all be strings");
  XCTAssertEqualObjects(BGSRNErrorMessage(ErrorIn(BGSRNJSONErrorDomain, @"malformed JSON")), @"malformed JSON");
  XCTAssertEqualObjects(BGSRNErrorMessage(ErrorIn(BGSRNExceptionsErrorDomain, @"domain must be a string")),
                        @"domain must be a string");
}

- (void)testNeverPassesAForeignErrorsMessage {
  NSError *foreign = ErrorIn(NSCocoaErrorDomain, @"/private/var/mobile/s3cret-user/file.txt");
  XCTAssertEqualObjects(BGSRNErrorMessage(foreign), BGSRNForeignErrorMessage);
  XCTAssertEqualObjects(BGSRNErrorMessage(ErrorIn(@"BGSRNLookalikeDomain", @"s3cret")), BGSRNForeignErrorMessage);
}

- (void)testANilErrorIsTheFixedMessageToo {
  XCTAssertEqualObjects(BGSRNErrorMessage(nil), BGSRNForeignErrorMessage);
}

/// A bridge error built without a message (no `NSLocalizedDescriptionKey`)
/// must not fall back to Foundation's generated text, which names the domain
/// and code and nothing useful.
- (void)testABridgeErrorWithoutAMessageIsTheFixedMessage {
  NSError *bare = [NSError errorWithDomain:BGSRNReportErrorDomain code:1 userInfo:nil];
  XCTAssertEqualObjects(BGSRNErrorMessage(bare), BGSRNForeignErrorMessage);
}

@end
