@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// `BGSRNErrorMessage` is the one place the bridge reads an `NSError`'s
/// message. It composes the bridge's OWN messages -- a literal description,
/// an identifier, an own underlying error -- and never passes a foreign
/// error's text, which can carry anything (a system parser echoes the
/// malformed input, a file error names the path).
@interface BGSRNErrorMessageTests : XCTestCase
@end

@implementation BGSRNErrorMessageTests

- (void)testPassesTheBridgesOwnDescriptionsThrough {
  NSError *report = [NSError errorWithDomain:BGSRNReportErrorDomain
                                        code:1
                                    userInfo:@{NSLocalizedDescriptionKey : @"labels must all be strings"}];
  NSError *json = [NSError errorWithDomain:BGSRNJSONErrorDomain
                                      code:1
                                  userInfo:@{NSLocalizedDescriptionKey : @"malformed JSON"}];
  NSError *exceptions = [NSError errorWithDomain:BGSRNExceptionsErrorDomain
                                            code:1
                                        userInfo:@{NSLocalizedDescriptionKey : @"domain must be a string"}];
  XCTAssertEqualObjects(BGSRNErrorMessage(report), @"labels must all be strings");
  XCTAssertEqualObjects(BGSRNErrorMessage(json), @"malformed JSON");
  XCTAssertEqualObjects(BGSRNErrorMessage(exceptions), @"domain must be a string");
}

- (void)testPutsTheIdentifierWhereTheDescriptionSays {
  NSError *error = [NSError errorWithDomain:BGSRNReportErrorDomain
                                       code:1
                                   userInfo:@{
                                     NSLocalizedDescriptionKey : @"unknown key \"{identifier}\"",
                                     BGSRNErrorIdentifierKey : @"summray",
                                   }];
  XCTAssertEqualObjects(BGSRNErrorMessage(error), @"unknown key \"summray\"");
}

- (void)testIgnoresAnIdentifierThatIsNotAString {
  NSError *error = [NSError errorWithDomain:BGSRNReportErrorDomain
                                       code:1
                                   userInfo:@{
                                     NSLocalizedDescriptionKey : @"unknown key \"{identifier}\"",
                                     BGSRNErrorIdentifierKey : @42,
                                   }];
  XCTAssertEqualObjects(BGSRNErrorMessage(error), @"unknown key \"{identifier}\"");
}

- (void)testAppendsAnOwnUnderlyingErrorOnly {
  NSError *own = [NSError errorWithDomain:BGSRNJSONErrorDomain
                                     code:1
                                 userInfo:@{NSLocalizedDescriptionKey : @"malformed JSON"}];
  NSError *foreign = [NSError errorWithDomain:NSCocoaErrorDomain
                                         code:3840
                                     userInfo:@{NSLocalizedDescriptionKey : @"s3cret-input"}];
  NSError *withOwn = [NSError errorWithDomain:BGSRNReportErrorDomain
                                         code:1
                                     userInfo:@{
                                       NSLocalizedDescriptionKey : @"patch is not a JSON object",
                                       NSUnderlyingErrorKey : own,
                                     }];
  NSError *withForeign = [NSError errorWithDomain:BGSRNReportErrorDomain
                                             code:1
                                         userInfo:@{
                                           NSLocalizedDescriptionKey : @"patch is not a JSON object",
                                           NSUnderlyingErrorKey : foreign,
                                         }];
  NSError *withNull = [NSError errorWithDomain:BGSRNReportErrorDomain
                                          code:1
                                      userInfo:@{
                                        NSLocalizedDescriptionKey : @"patch is not a JSON object",
                                        NSUnderlyingErrorKey : NSNull.null,
                                      }];
  XCTAssertEqualObjects(BGSRNErrorMessage(withOwn), @"patch is not a JSON object: malformed JSON");
  XCTAssertEqualObjects(BGSRNErrorMessage(withForeign), @"patch is not a JSON object");
  XCTAssertEqualObjects(BGSRNErrorMessage(withNull), @"patch is not a JSON object");
}

- (void)testNeverPassesAForeignErrorsMessage {
  NSError *foreign = [NSError errorWithDomain:NSCocoaErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey : @"/private/var/mobile/s3cret-user/file.txt"}];
  NSError *lookalike = [NSError errorWithDomain:@"BGSRNLookalikeDomain"
                                           code:1
                                       userInfo:@{NSLocalizedDescriptionKey : @"s3cret"}];
  XCTAssertEqualObjects(BGSRNErrorMessage(foreign), BGSRNForeignErrorMessage);
  XCTAssertEqualObjects(BGSRNErrorMessage(lookalike), BGSRNForeignErrorMessage);
}

- (void)testANilErrorIsTheFixedMessageToo {
  XCTAssertEqualObjects(BGSRNErrorMessage(nil), BGSRNForeignErrorMessage);
}

/// A bridge error built without a description must not fall back to
/// Foundation's generated text, which names the domain and code.
- (void)testABridgeErrorWithoutADescriptionIsTheFixedMessage {
  NSError *bare = [NSError errorWithDomain:BGSRNReportErrorDomain code:1 userInfo:nil];
  XCTAssertEqualObjects(BGSRNErrorMessage(bare), BGSRNForeignErrorMessage);
}

@end
