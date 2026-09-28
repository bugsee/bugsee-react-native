#import "BGSRNFakeReport.h"

/// An attachment carrying only what the bridge reads: its name.
@interface BGSRNFakeAttachment : NSObject <BGSAttachmentContract>
@end

@implementation BGSRNFakeAttachment
@synthesize name = _name;
@synthesize mimeType = _mimeType;
@synthesize fileName = _fileName;
@synthesize filePath = _filePath;
@synthesize data = _data;

- (void)deleteFile {
  [NSException raise:NSInternalInconsistencyException format:@"BGSRNFakeAttachment does not model deleteFile"];
}

- (void)deleteFileAsync:(void (^)(BOOL))completion {
  [NSException raise:NSInternalInconsistencyException format:@"BGSRNFakeAttachment does not model deleteFileAsync:"];
}
@end

static void Unmodeled(SEL selector) {
  [NSException raise:NSInternalInconsistencyException
              format:@"BGSRNFakeReport does not model %@", NSStringFromSelector(selector)];
}

@implementation BGSRNFakeReport

- (instancetype)init {
  self = [super init];
  if (self) {
    _fakeReportId = @"report-1";
    _fakeType = @"bug";
    _fakeLabels = [NSMutableArray array];
    _fakeAttributes = [NSMutableDictionary dictionary];
    _fakeScreenshotDisplayIds = @[];
    _fakeAttachmentNames = [NSMutableArray array];
    _mutations = [NSMutableArray array];
  }
  return self;
}

- (void)record:(SEL)selector {
  [_mutations addObject:NSStringFromSelector(selector)];
}

#pragma mark - Modelled

- (NSString *)reportId { return _fakeReportId; }
- (NSString *)type { return _fakeType; }

- (NSString *)summary { return _fakeSummary; }
- (void)setSummary:(NSString *)summary {
  [self record:_cmd];
  _fakeSummary = [summary copy];
}

- (NSString *)reportDescription { return _fakeDescription; }
- (void)setReportDescription:(NSString *)reportDescription {
  [self record:_cmd];
  _fakeDescription = [reportDescription copy];
}

- (BugseeSeverityLevel)severity { return _fakeSeverity; }
- (void)setSeverity:(BugseeSeverityLevel)severity {
  [self record:_cmd];
  // The SDK's own refusal: out of range keeps the current value, silently.
  if (severity >= BugseeSeverityLow && severity <= BugseeSeverityBlocker) {
    _fakeSeverity = severity;
  }
}

- (NSMutableArray<NSString *> *)labels { return [_fakeLabels mutableCopy]; }
- (void)addLabel:(NSString *)label {
  [self record:_cmd];
  [_fakeLabels addObject:label];
}
- (void)addLabels:(NSArray<NSString *> *)labels {
  [self record:_cmd];
  [_fakeLabels addObjectsFromArray:labels];
}
- (void)clearLabels {
  [self record:_cmd];
  [_fakeLabels removeAllObjects];
}
- (void)replaceLabels:(NSArray<NSString *> *)labels {
  [self record:_cmd];
  [_fakeLabels setArray:labels];
}

- (NSMutableDictionary<NSString *, id> *)attributes { return [_fakeAttributes mutableCopy]; }
- (id)attributeForName:(NSString *)name { return _fakeAttributes[name]; }
- (void)setAttribute:(id)value forName:(NSString *)name {
  [self record:_cmd];
  _fakeAttributes[name] = value;
}
- (void)removeAttributeForName:(NSString *)name {
  [self record:_cmd];
  [_fakeAttributes removeObjectForKey:name];
}
- (void)clearAllAttributes {
  [self record:_cmd];
  [_fakeAttributes removeAllObjects];
}

- (NSArray<NSNumber *> *)screenshotDisplayIds { return _fakeScreenshotDisplayIds; }

- (NSMutableArray<id<BGSAttachmentContract>> *)attachments {
  NSMutableArray *result = [NSMutableArray array];
  for (NSString *name in _fakeAttachmentNames) {
    BGSRNFakeAttachment *attachment = [BGSRNFakeAttachment new];
    attachment.name = name;
    [result addObject:attachment];
  }
  return result;
}

- (id<BGSAttachmentContract>)addAttachmentWithFilePath:(NSString *)filePath
                                                  name:(NSString *)name
                                              mimeType:(NSString *)mimeType
                                                  move:(BOOL)move {
  [self record:_cmd];
  self.lastFileAttachment = @[ filePath, name, mimeType ?: (id)NSNull.null, @(move) ];
  return [self added:name];
}

- (id<BGSAttachmentContract>)addAttachmentWithData:(NSData *)data
                                              name:(NSString *)name
                                          mimeType:(NSString *)mimeType {
  [self record:_cmd];
  self.lastDataAttachment = @[ data, name, mimeType ?: (id)NSNull.null ];
  return [self added:name];
}

- (id<BGSAttachmentContract>)added:(NSString *)name {
  if (_rejectAttachments) {
    return nil;
  }
  [_fakeAttachmentNames addObject:name];
  BGSRNFakeAttachment *attachment = [BGSRNFakeAttachment new];
  attachment.name = name;
  return attachment;
}

#pragma mark - Not modelled

- (NSString *)email { Unmodeled(_cmd); return nil; }
- (void)setEmail:(NSString *)email { Unmodeled(_cmd); }
- (id<BGSAttachmentContract>)createAndAddAttachmentWithName:(NSString *)name { Unmodeled(_cmd); return nil; }
- (void)addAttachment:(id<BGSAttachmentContract>)attachment { Unmodeled(_cmd); }
- (void)clearAttachments { Unmodeled(_cmd); }
- (void)getScreenshotForDisplayId:(NSInteger)displayId completion:(void (^)(UIImage *))completion { Unmodeled(_cmd); }
- (void)enumerateScreenshots:(void (^)(NSInteger, UIImage *))callback blockAndWait:(BOOL)blockAndWait { Unmodeled(_cmd); }
- (void)releaseScreenshotBitmaps { Unmodeled(_cmd); }
- (void)setScreenshot:(UIImage *)screenshot displayId:(NSInteger)displayId annotated:(BOOL)annotated completion:(BGSCallback)completion { Unmodeled(_cmd); }
- (void)setScreenshot:(UIImage *)screenshot displayId:(NSInteger)displayId { Unmodeled(_cmd); }
- (void)setScreenshot:(UIImage *)screenshot displayId:(NSInteger)displayId completion:(BGSCallback)completion { Unmodeled(_cmd); }
- (void)setScreenshot:(UIImage *)screenshot displayId:(NSInteger)displayId annotated:(BOOL)annotated { Unmodeled(_cmd); }
- (NSDictionary<NSString *, id> *)screenshotAttributesForDisplayId:(NSInteger)displayId { Unmodeled(_cmd); return nil; }
- (BOOL)isScreenshotChanged { Unmodeled(_cmd); return NO; }
- (void)updateFromReport:(id<BGSReportContract>)report { Unmodeled(_cmd); }
- (void)updateFromReport:(id<BGSReportContract>)report completion:(BGSCallback)completion { Unmodeled(_cmd); }
- (void)exportVideoToPath:(NSString *)exportPath completion:(void (^)(NSArray<NSString *> *))completion { Unmodeled(_cmd); }

@end
