@import XCTest;
@import Bugsee;
@import BugseeRNSupport;
@import UIKit;

/// On a real `BugseeExtendedReport`. Its attributes live in a file-scope
/// global that `-init` resets, so each case that needs a value sets it on
/// the report it is about to read.
@interface BGSRNCreatedReportOpsTests : XCTestCase
@end

@implementation BGSRNCreatedReportOpsTests {
  BugseeExtendedReport *_report;
}

- (void)setUp {
  [super setUp];
  _report = [BugseeExtendedReport new];
}

- (BOOL)apply:(NSString *)json error:(NSError **)error {
  return [BGSRNCreatedReportOps applyPatchJSON:json toReport:_report error:error];
}

- (UIImage *)onePixel {
  UIGraphicsImageRenderer *renderer =
      [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(1, 1)];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    [[UIColor redColor] setFill];
    [context fillRect:CGRectMake(0, 0, 1, 1)];
  }];
}

- (void)testReadsTheFields {
  XCTAssertEqualObjects([BGSRNCreatedReportOps readReport:_report][@"screenshotDisplayIds"], @[]);

  [_report setSummary:@"sum"];
  [_report setDescription:@"desc"];
  [_report setSeverity:BugseeSeverityCritical];
  _report.labels = @[ @"a", @"b" ];
  [_report setAttribute:@"k" withValue:@"v"];
  [_report setScreenshot:[self onePixel]];
  BugseeAttachment *attachment = [BugseeAttachment attachmentWithName:@"note.txt"
                                                             filename:@"note.txt"
                                                                 data:[@"hi" dataUsingEncoding:NSUTF8StringEncoding]];
  [_report setAttachment:attachment];

  NSDictionary *read = [BGSRNCreatedReportOps readReport:_report];
  XCTAssertEqualObjects(read[@"summary"], @"sum");
  XCTAssertEqualObjects(read[@"description"], @"desc");
  XCTAssertEqualObjects(read[@"severity"], @4);
  XCTAssertEqualObjects(read[@"labels"], (@[ @"a", @"b" ]));
  XCTAssertEqualObjects(read[@"attributes"], @{ @"k" : @"v" });
  XCTAssertEqualObjects(read[@"screenshotDisplayIds"], (@[ @0 ]));
  XCTAssertEqualObjects(read[@"attachmentNames"], @[ @"note.txt" ]);
}

/// A valid field beside an invalid one must not land.
- (void)testPatchIsAllOrNothing {
  [_report setSummary:@"old"];
  _report.labels = @[ @"keep" ];
  [_report setAttribute:@"k" withValue:@"v"];

  NSError *error = nil;
  XCTAssertFalse([self apply:@"{\"summary\":\"new\",\"labels\":[\"x\"],\"severity\":9}" error:&error]);
  XCTAssertEqualObjects(error.domain, BGSRNReportErrorDomain);
  XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
  XCTAssertEqualObjects(_report.summary, @"old");
  XCTAssertEqualObjects(_report.labels, (@[ @"keep" ]));
  XCTAssertEqualObjects(_report.attributes[@"k"], @"v");
}

- (void)testLabelsReplace {
  _report.labels = @[ @"old" ];
  NSError *error = nil;
  XCTAssertTrue([self apply:@"{\"labels\":[\"x\",\"y\"]}" error:&error], @"%@", error);
  XCTAssertEqualObjects(_report.labels, (@[ @"x", @"y" ]));
}

- (void)testNSNullClearsTheSummaryAndRemovesAnAttribute {
  [_report setSummary:@"s"];
  [_report setDescription:@"d"];
  [_report setAttribute:@"gone" withValue:@"v"];
  [_report setAttribute:@"kept" withValue:@"v"];

  NSError *error = nil;
  XCTAssertTrue([self apply:@"{\"summary\":null,\"attributes\":{\"gone\":null}}" error:&error], @"%@", error);
  XCTAssertNil(_report.summary);
  XCTAssertEqualObjects(_report.reportDescription, @"d");
  XCTAssertNil(_report.attributes[@"gone"]);
  XCTAssertEqualObjects(_report.attributes[@"kept"], @"v");
}

/// Clear runs before the attributes of the same patch, whatever key order
/// the dictionary walks in.
- (void)testClearAttributesRunsFirst {
  [_report setAttribute:@"old" withValue:@"v"];
  NSError *error = nil;
  XCTAssertTrue([self apply:@"{\"attributes\":{\"fresh\":\"n\"},\"clearAttributes\":true}" error:&error],
                @"%@", error);
  XCTAssertNil(_report.attributes[@"old"]);
  XCTAssertEqualObjects(_report.attributes[@"fresh"], @"n");
}

- (void)testAFourthAttachmentIsRejected {
  NSError *error = nil;
  for (NSInteger i = 0; i < 3; i++) {
    NSString *attachmentName = [NSString stringWithFormat:@"n-%ld", (long)i];
    XCTAssertTrue([BGSRNCreatedReportOps addData:@"AQ==" name:attachmentName toReport:_report error:&error],
                  @"%@", error);
  }
  error = nil;
  XCTAssertFalse([BGSRNCreatedReportOps addData:@"AQ==" name:@"fourth" toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);
  XCTAssertEqualObjects(BGSRNReportErrorWireCode(error), @"E_REPORT_ATTACHMENT_REJECTED");
  XCTAssertEqual(_report.attachments.count, 3u);
  NSArray *names = [BGSRNCreatedReportOps readReport:_report][@"attachmentNames"];
  XCTAssertFalse([names containsObject:@"fourth"]);
}

- (void)testAnAttachmentOver3MiBIsRejected {
  NSMutableData *data = [NSMutableData dataWithLength:BGSRNCreatedReportAttachmentMaxBytes + 1];
  NSString *base64 = [data base64EncodedStringWithOptions:0];
  NSError *error = nil;
  XCTAssertFalse([BGSRNCreatedReportOps addData:base64 name:@"big.bin" toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);
  XCTAssertEqual(_report.attachments.count, 0u);
}

- (void)testAnEmptyAttachmentIsRejected {
  NSError *error = nil;
  XCTAssertFalse([BGSRNCreatedReportOps addData:@"" name:@"empty.bin" toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);
  XCTAssertEqual(_report.attachments.count, 0u);

  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  XCTAssertTrue([@"" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil]);
  [self addTeardownBlock:^{
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
  }];
  error = nil;
  XCTAssertFalse([BGSRNCreatedReportOps addFileAtPath:path name:@"empty.txt" toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);
}

- (void)testAMissingFileIsRejected {
  NSError *error = nil;
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:
                                             [NSString stringWithFormat:@"missing-%@", NSUUID.UUID.UUIDString]];
  XCTAssertFalse([BGSRNCreatedReportOps addFileAtPath:path name:@"gone.txt" toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);
  XCTAssertEqual(_report.attachments.count, 0u);
}

/// The bytes are taken at add time. Overwriting the file afterwards leaves
/// the attachment holding what was there.
- (void)testAFileIsCapturedWhenAdded {
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  NSData *original = [@"original-bytes" dataUsingEncoding:NSUTF8StringEncoding];
  XCTAssertTrue([original writeToFile:path atomically:YES]);
  [self addTeardownBlock:^{
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
  }];

  NSError *error = nil;
  XCTAssertTrue([BGSRNCreatedReportOps addFileAtPath:path name:@"note.txt" toReport:_report error:&error],
                @"%@", error);

  NSData *changed = [@"changed-bytes!" dataUsingEncoding:NSUTF8StringEncoding];
  XCTAssertEqual(changed.length, original.length);
  XCTAssertTrue([changed writeToFile:path atomically:NO]);

  XCTAssertEqualObjects(_report.attachments.lastObject.data, original);
  XCTAssertEqualObjects(_report.attachments.lastObject.name, @"note.txt");
  XCTAssertEqualObjects(_report.attachments.lastObject.filename, @"note.txt");
}

- (void)testInvalidBase64IsABadArgument {
  NSError *error = nil;
  XCTAssertFalse([BGSRNCreatedReportOps addData:@"not base64!" name:@"blob" toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
  XCTAssertEqualObjects(BGSRNReportErrorWireCode(error), @"E_REPORT_BAD_ARGUMENT");
  XCTAssertEqual(_report.attachments.count, 0u);
}

- (void)testTheLimitsMirrorTheSdk {
  XCTAssertEqual(BGSRNCreatedReportAttachmentMaxCount, 3u,
                 @"BGSRNCreatedReportAttachmentMaxCount mirrors the SDK's ATTACHMENTS_LIMIT");
  XCTAssertEqual(BGSRNCreatedReportAttachmentMaxBytes, 3145728u,
                 @"BGSRNCreatedReportAttachmentMaxBytes mirrors the SDK's MAX_SIZE_ATTACHMENT");
}

/// beta3 stores `internalAttributes` in a file-scope global and `-init`
/// replaces it. When this fails, that bug is gone and P5 (one created report
/// at a time) can be lifted.
- (void)testTheSdkSharesAttributesAcrossExtendedReports {
  BugseeExtendedReport *first = [BugseeExtendedReport new];
  [first setAttribute:@"only-a" withValue:@"1"];
  XCTAssertEqualObjects(first.attributes[@"only-a"], @"1");

  BugseeExtendedReport *second = [BugseeExtendedReport new];
  XCTAssertNil(first.attributes[@"only-a"],
               @"When this fails, BugseeExtendedReport no longer keeps attributes in a file-scope "
               @"global that -init resets, and P5 (one created report at a time) can be lifted. "
               @"The second report is %@",
               second);
}

@end
