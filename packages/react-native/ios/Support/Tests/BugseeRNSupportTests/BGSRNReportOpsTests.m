@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

#import "BGSRNFakeReport.h"

/// Mirrors Android's `ReportOpsTest` by name where the rule is shared.
@interface BGSRNReportOpsTests : XCTestCase
@end

@implementation BGSRNReportOpsTests {
  BGSRNFakeReport *_report;
}

- (void)setUp {
  [super setUp];
  _report = [BGSRNFakeReport new];
}

- (void)assertRejected:(NSDictionary *)patch {
  NSError *error = nil;
  XCTAssertFalse([BGSRNReportOps applyPatch:patch toReport:_report error:&error], @"accepted %@", patch);
  XCTAssertEqualObjects(error.domain, BGSRNReportErrorDomain);
  XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
  XCTAssertEqualObjects(BGSRNReportErrorWireCode(error), @"E_REPORT_BAD_ARGUMENT");
}

- (void)assertApplied:(NSDictionary *)patch {
  NSError *error = nil;
  const BOOL applied = [BGSRNReportOps applyPatch:patch toReport:_report error:&error];
  XCTAssertTrue(applied, @"rejected %@: %@", patch, error);
  XCTAssertNil(error);
}

#pragma mark - Severity

/// An untouched report reads 0, "not set". It crosses as 0; JS maps it to
/// undefined rather than inventing a level nobody chose.
- (void)testReadsUnsetSeverityAsZero {
  XCTAssertEqualObjects([BGSRNReportOps readReport:_report][@"severity"], @0);
}

/// By the SDK's value, which both platforms and the JS type speak.
- (void)testReadsSeverityByValue {
  _report.fakeSeverity = BugseeSeverityCritical;
  XCTAssertEqualObjects([BGSRNReportOps readReport:_report][@"severity"], @4);
}

- (void)testAppliesSeverityOneToFive {
  for (NSInteger value = 1; value <= 5; value++) {
    NSError *error = nil;
    XCTAssertTrue([BGSRNReportOps applyPatch:@{ @"severity" : @((double)value) } toReport:_report error:&error]);
    XCTAssertNil(error);
    XCTAssertEqual((NSInteger)_report.fakeSeverity, value);
  }
}

/// The SDK setter IGNORES a value outside 1..5 and keeps the current one --
/// silently. Unchecked, `setSeverity(0)` would resolve as if it had worked.
- (void)testRejectsSeverityZeroAndSixAndLeavesTheReportAlone {
  _report.fakeSeverity = BugseeSeverityHigh;
  [self assertRejected:@{ @"severity" : @0 }];
  [self assertRejected:@{ @"severity" : @6 }];
  [self assertRejected:@{ @"severity" : @2.5 }];
  [self assertRejected:@{ @"severity" : @"3" }];
  [self assertRejected:@{ @"severity" : @YES }];
  [self assertRejected:@{ @"severity" : NSNull.null }];
  XCTAssertEqual(_report.fakeSeverity, BugseeSeverityHigh);
  XCTAssertEqualObjects(_report.mutations, @[]);
}

#pragma mark - Patch

/// A valid field next to an invalid one must not land on its own.
- (void)testPatchIsAllOrNothing {
  [self assertRejected:@{
    @"summary" : @"new summary",
    @"labels" : @[ @"a", @"b" ],
    @"attributes" : @{ @"k" : @"v" },
    @"severity" : @9,
  }];
  XCTAssertNil(_report.fakeSummary);
  XCTAssertEqual(_report.fakeLabels.count, 0u);
  XCTAssertEqual(_report.fakeAttributes.count, 0u);
  XCTAssertEqualObjects(_report.mutations, @[]);
}

/// Parity with the JS proxy, which rejects it before crossing: an empty
/// attribute name is a bad argument like any other malformed field, and fails
/// the whole patch -- the valid name next to it included.
- (void)testRejectsAnEmptyAttributeNameAndAppliesNothing {
  NSDictionary *patch = @{
    @"summary" : @"new summary",
    @"attributes" : @{ @"ok" : @"v", @"" : @"x" },
  };
  [self assertRejected:patch];
  NSError *error = nil;
  [BGSRNReportOps applyPatch:patch toReport:_report error:&error];
  XCTAssertEqualObjects(error.localizedDescription, @"attribute name must be a non-empty string");
  XCTAssertNil(_report.fakeSummary);
  XCTAssertEqual(_report.fakeAttributes.count, 0u);
  XCTAssertEqualObjects(_report.mutations, @[]);
}

/// One call, not `clearLabels` + `addLabels:`: between the two, the SDK (or a
/// concurrent reader) would see a report with no labels at all.
- (void)testLabelsReplaceThroughReplaceLabels {
  [_report.fakeLabels addObject:@"old"];
  [self assertApplied:@{ @"labels" : @[ @"x", @"y" ] }];
  XCTAssertEqualObjects(_report.fakeLabels, (@[ @"x", @"y" ]));
  XCTAssertEqualObjects(_report.mutations, @[ @"replaceLabels:" ]);
}

- (void)testNSNullRemovesAnAttribute {
  _report.fakeAttributes[@"gone"] = @"value";
  _report.fakeAttributes[@"kept"] = @"value";
  [self assertApplied:@{ @"attributes" : @{ @"gone" : NSNull.null, @"added" : @7 } }];
  XCTAssertNil(_report.fakeAttributes[@"gone"]);
  XCTAssertEqualObjects(_report.fakeAttributes[@"kept"], @"value");
  XCTAssertEqualObjects(_report.fakeAttributes[@"added"], @7);
  XCTAssertTrue([_report.mutations containsObject:@"removeAttributeForName:"]);
}

/// Clear-then-set in one patch, whatever order the dictionary iterates in.
- (void)testClearAttributesRunsBeforeAttributes {
  _report.fakeAttributes[@"old"] = @"value";
  [self assertApplied:@{ @"attributes" : @{ @"fresh" : @YES }, @"clearAttributes" : @YES }];
  XCTAssertEqualObjects(_report.fakeAttributes, @{ @"fresh" : @YES });
  XCTAssertEqualObjects(_report.mutations, (@[ @"clearAllAttributes", @"setAttribute:forName:" ]));
}

- (void)testSummaryAndDescriptionSetAndClear {
  _report.fakeDescription = @"old";
  [self assertApplied:@{ @"summary" : @"s", @"description" : NSNull.null }];
  XCTAssertEqualObjects(_report.fakeSummary, @"s");
  XCTAssertNil(_report.fakeDescription);
}

/// A misspelled key must fail loudly, not drop part of the patch.
- (void)testUnknownPatchKeyIsRejected {
  [self assertRejected:@{ @"summary" : @"s", @"sumary" : @"typo" }];
  XCTAssertNil(_report.fakeSummary);
}

- (void)testMalformedFieldsAreRejected {
  [self assertRejected:@{ @"summary" : @3 }];
  [self assertRejected:@{ @"labels" : @"a" }];
  [self assertRejected:@{ @"labels" : @[ @"a", @1 ] }];
  [self assertRejected:@{ @"clearAttributes" : @NO }];
  [self assertRejected:@{ @"clearAttributes" : @1 }];
  [self assertRejected:@{ @"attributes" : @[] }];
  [self assertRejected:@{ @"attributes" : @{ @"k" : @[] } }];
  [self assertRejected:@{ @"attributes" : @{ @"k" : @(INFINITY) } }];
  XCTAssertEqualObjects(_report.mutations, @[]);
}

/// JS numbers are doubles; an integral one is stored as an integer, so an
/// attribute of 3 reaches the backend as 3 and not 3.0.
- (void)testIntegralNumbersCrossAsIntegers {
  [self assertApplied:@{ @"attributes" : @{ @"n" : @3.0, @"f" : @2.5, @"b" : @YES } }];
  NSNumber *n = _report.fakeAttributes[@"n"];
  XCTAssertNotNil(n);
  XCTAssertEqualObjects(n ? @(n.objCType) : nil, @(@encode(long long)));
  XCTAssertEqualObjects(_report.fakeAttributes[@"n"], @3);
  XCTAssertEqualObjects(_report.fakeAttributes[@"f"], @2.5);
  XCTAssertEqual((__bridge CFBooleanRef)_report.fakeAttributes[@"b"], kCFBooleanTrue);
}

#pragma mark - Read

/// The SDK documents these ascending; sorted again here, defensively.
- (void)testScreenshotIdsAreSortedAscending {
  _report.fakeScreenshotDisplayIds = @[ @2, @0, @1 ];
  XCTAssertEqualObjects([BGSRNReportOps readReport:_report][@"screenshotDisplayIds"], (@[ @0, @1, @2 ]));
}

/// The whole snapshot the JS side normalises, in one read.
- (void)testReadReturnsTheWholeSnapshot {
  _report.fakeSummary = @"s";
  _report.fakeDescription = @"d";
  [_report.fakeLabels addObject:@"l"];
  _report.fakeAttributes[@"n"] = @1;
  _report.fakeAttributes[@"opaque"] = [NSDate date];
  [_report.fakeAttachmentNames addObject:@"a.txt"];

  NSDictionary *read = [BGSRNReportOps readReport:_report];

  XCTAssertEqualObjects(read[@"summary"], @"s");
  XCTAssertEqualObjects(read[@"description"], @"d");
  XCTAssertEqualObjects(read[@"labels"], @[ @"l" ]);
  // A value JS has no type for is dropped, not stringified into a fake one.
  XCTAssertEqualObjects(read[@"attributes"], @{ @"n" : @1 });
  XCTAssertEqualObjects(read[@"attachmentNames"], @[ @"a.txt" ]);
  XCTAssertEqualObjects(_report.mutations, @[]);
}

/// Unset text is omitted rather than NSNull; JS reads either as undefined.
- (void)testReadOmitsUnsetText {
  NSDictionary *read = [BGSRNReportOps readReport:_report];
  XCTAssertNil(read[@"summary"]);
  XCTAssertNil(read[@"description"]);
}

#pragma mark - Attachments

- (void)testANilFromTheSdkIsARejectedAttachment {
  _report.rejectAttachments = YES;
  NSError *error = nil;
  XCTAssertFalse([BGSRNReportOps addData:@"AQ==" name:@"blob" mimeType:nil toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);
  XCTAssertEqualObjects(BGSRNReportErrorWireCode(error), @"E_REPORT_ATTACHMENT_REJECTED");

  error = nil;
  XCTAssertFalse([BGSRNReportOps addFileAtPath:@"/nonexistent"
                                          name:@"file"
                                      mimeType:nil
                                          move:NO
                                      toReport:_report
                                         error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorAttachmentRejected);

  _report.rejectAttachments = NO;
  error = nil;
  XCTAssertTrue([BGSRNReportOps addData:@"AQ==" name:@"blob" mimeType:@"application/octet-stream" toReport:_report error:&error]);
  XCTAssertNil(error);
  const uint8_t one = 1;
  XCTAssertEqualObjects(_report.lastDataAttachment,
                        (@[ [NSData dataWithBytes:&one length:1], @"blob", @"application/octet-stream" ]));
}

/// Undecodable input never reaches the SDK.
- (void)testInvalidBase64IsABadArgument {
  NSError *error = nil;
  XCTAssertFalse([BGSRNReportOps addData:@"not base64!" name:@"blob" mimeType:nil toReport:_report error:&error]);
  XCTAssertEqual(error.code, BGSRNReportErrorBadArgument);
  XCTAssertEqualObjects(BGSRNReportErrorWireCode(error), @"E_REPORT_BAD_ARGUMENT");
  XCTAssertNil(_report.lastDataAttachment);
  XCTAssertEqualObjects(_report.mutations, @[]);
}

- (void)testFileAttachmentPassesMoveThrough {
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:
                                               [NSString stringWithFormat:@"bugsee-rn-%@.log", NSUUID.UUID.UUIDString]];
  XCTAssertTrue([@"log" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil]);
  [self addTeardownBlock:^{
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
  }];

  NSError *error = nil;
  XCTAssertTrue([BGSRNReportOps addFileAtPath:path name:@"app.log" mimeType:@"text/plain" move:YES toReport:_report error:&error]);
  XCTAssertEqualObjects(_report.lastFileAttachment, (@[ path, @"app.log", @"text/plain", @YES ]));

  XCTAssertTrue([BGSRNReportOps addFileAtPath:path name:@"app.log" mimeType:nil move:NO toReport:_report error:&error]);
  XCTAssertEqualObjects(_report.lastFileAttachment, (@[ path, @"app.log", NSNull.null, @NO ]));
}

- (void)testWireCodeIsNilForAForeignError {
  XCTAssertNil(BGSRNReportErrorWireCode([NSError errorWithDomain:NSCocoaErrorDomain code:1 userInfo:nil]));
}

@end
