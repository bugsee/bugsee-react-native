@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// A non-UTF-8 body must survive the filter's identity and spread replies.
/// The snapshot omits `body` for those bytes; apply leaves a missing key
/// alone. JSON null is reserved for a body that is actually nil or empty,
/// and that null still clears.
@interface BGSRNNetworkFilterTests : XCTestCase
@end

@implementation BGSRNNetworkFilterTests

- (BugseeNetworkEvent *)eventWithBody:(NSData *)body {
  return [BugseeNetworkEvent eventWithID:@"req-1"
                               HTTPmethod:@"GET"
                                     type:BugseeWebSocket
                          bugseeEventType:@"message"
                                      url:@"wss://example/hot"
                            redirectedUrl:nil
                                     body:body
                                    error:nil
                                  headers:@{@"Content-Type" : @"application/octet-stream"}
                             noBodyReason:nil
                                 dataSize:(int64_t)body.length
                             responseCode:0];
}

- (NSDictionary *)payloadOf:(BugseeNetworkEvent *)event {
  NSString *json = BGSRNNetworkEventJSON(event);
  XCTAssertNotNil(json);
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  XCTAssertTrue([parsed isKindOfClass:[NSDictionary class]]);
  return parsed;
}

- (void)testANonUTF8BodySurvivesAnIdentityOrSpreadReply {
  const uint8_t jpeg[] = {0xFF, 0xD8, 0xFF, 0x00};
  NSData *body = [NSData dataWithBytes:jpeg length:sizeof(jpeg)];
  BugseeNetworkEvent *event = [self eventWithBody:body];

  NSDictionary *snapshot = [self payloadOf:event];
  XCTAssertFalse([snapshot.allKeys containsObject:@"body"]);

  NSString *identity = BGSRNNetworkEventJSON(event);
  XCTAssertTrue(BGSRNApplyNetworkReplacement(event, identity));
  XCTAssertEqualObjects(event.body, body);

  NSMutableDictionary *spread = [snapshot mutableCopy];
  spread[@"url"] = @"wss://example/hot?bugsee-e2e-redacted=1";
  NSData *replyData = [NSJSONSerialization dataWithJSONObject:spread options:0 error:nil];
  NSString *reply = [[NSString alloc] initWithData:replyData encoding:NSUTF8StringEncoding];
  XCTAssertFalse([reply containsString:@"\"body\""]);
  XCTAssertTrue(BGSRNApplyNetworkReplacement(event, reply));
  XCTAssertEqualObjects(event.body, body);
  XCTAssertEqualObjects(event.url, spread[@"url"]);
}

- (void)testANilOrEmptyBodyIsJsonNullAndNullClears {
  BugseeNetworkEvent *empty = [self eventWithBody:[NSData data]];
  XCTAssertEqualObjects([self payloadOf:empty][@"body"], NSNull.null);

  BugseeNetworkEvent *missing = [self eventWithBody:nil];
  XCTAssertEqualObjects([self payloadOf:missing][@"body"], NSNull.null);

  const uint8_t jpeg[] = {0xFF, 0xD8, 0xFF, 0x00};
  NSData *body = [NSData dataWithBytes:jpeg length:sizeof(jpeg)];
  BugseeNetworkEvent *event = [self eventWithBody:body];
  XCTAssertTrue(BGSRNApplyNetworkReplacement(event, @"{\"body\":null}"));
  XCTAssertNil(event.body);
}

- (void)testAUtf8BodyIsSent {
  NSData *body = [@"hello" dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *snapshot = [self payloadOf:[self eventWithBody:body]];
  XCTAssertEqualObjects(snapshot[@"body"], @"hello");
}

@end
