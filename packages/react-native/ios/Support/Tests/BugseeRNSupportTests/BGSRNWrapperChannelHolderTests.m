@import XCTest;
@import Bugsee;
@import BugseeRNSupport;

/// Records every call it receives. Implements every optional channel method,
/// standing in for a live SDK channel.
@interface BGSRNFullWrapperChannel : NSObject <BGSWrapperChannel>
@property (nonatomic, strong, readonly) NSMutableArray<NSDictionary *> *lines;
@property (nonatomic, strong, readonly) NSMutableArray *events;
@property (nonatomic, strong, readonly) NSMutableArray<NSNumber *> *requiresFilteringCalls;
@end

@implementation BGSRNFullWrapperChannel

- (instancetype)init {
  self = [super init];
  if (self) {
    _lines = [NSMutableArray array];
    _events = [NSMutableArray array];
    _requiresFilteringCalls = [NSMutableArray array];
  }
  return self;
}

- (void)logWithTag:(nullable NSString *)tag
           message:(nullable NSString *)message
             level:(BugseeLogLevel)level
            source:(BGSLogEventSource)source {
  [self.lines addObject:@{
    @"tag" : tag ?: [NSNull null],
    @"message" : message ?: [NSNull null],
    @"level" : @(level),
    @"source" : @(source),
  }];
}

- (void)addNetworkEvent:(nullable BugseeNetworkEvent *)event
      requiresFiltering:(BOOL)requiresFiltering {
  [self.events addObject:event ?: [NSNull null]];
  [self.requiresFilteringCalls addObject:@(requiresFiltering)];
}

@end

/// Conforms to the protocol but implements none of its @optional methods --
/// a channel shaped like one built against a newer SDK contract than this
/// wrapper compiles selectors for, or simply an incomplete test double.
@interface BGSRNChannelWithoutTheSelector : NSObject <BGSWrapperChannel>
@end

@implementation BGSRNChannelWithoutTheSelector
@end

@interface BGSRNWrapperChannelHolderTests : XCTestCase
@end

@implementation BGSRNWrapperChannelHolderTests

- (BugseeNetworkEvent *)networkEvent {
  return [BugseeNetworkEvent eventWithID:@"1"
                               HTTPmethod:@"GET"
                                     type:BugseeNetwork
                          bugseeEventType:nil
                                      url:@"https://example.com"
                            redirectedUrl:nil
                                     body:nil
                                    error:nil
                                  headers:nil
                             noBodyReason:nil
                                 dataSize:0
                             responseCode:200];
}

/**
 * Custom is the only honest attribution for a JS line; leaving it to the SDK
 * reads as Unknown on iOS. The tag is nil because iOS has nowhere to put one.
 */
- (void)testLogsWithSourceCustomAndNilTag {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];
  BGSRNFullWrapperChannel *channel = [BGSRNFullWrapperChannel new];
  holder.channel = channel;

  [holder logMessage:@"hello" level:3];

  XCTAssertEqual(channel.lines.count, (NSUInteger)1);
  NSDictionary *line = channel.lines[0];
  XCTAssertEqualObjects(line[@"tag"], [NSNull null]);
  XCTAssertEqualObjects(line[@"message"], @"hello");
  XCTAssertEqual([line[@"source"] integerValue], (NSInteger)BGSLogEventSourceCustom);
}

/**
 * By value, never by ordinal: BugseeLogLevelInvalid is 0 at ordinal 0, so
 * Error sits at ordinal 1 -- a bare `values()`-style walk would shift every
 * level.
 */
- (void)testMapsLevelsByValue {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];
  BGSRNFullWrapperChannel *channel = [BGSRNFullWrapperChannel new];
  holder.channel = channel;

  const BugseeLogLevel expected[] = {
    BugseeLogLevelError, BugseeLogLevelWarning, BugseeLogLevelInfo,
    BugseeLogLevelDebug, BugseeLogLevelVerbose,
  };
  for (NSInteger wire = 1; wire <= 5; wire++) {
    [holder logMessage:[NSString stringWithFormat:@"level %ld", (long)wire] level:wire];
  }

  XCTAssertEqual(channel.lines.count, (NSUInteger)5);
  for (NSInteger i = 0; i < 5; i++) {
    XCTAssertEqual([channel.lines[i][@"level"] integerValue], (NSInteger)expected[i],
                    @"wire %ld", (long)(i + 1));
  }
}

/**
 * JS rejects these before they cross, so reaching here is a bridge bug; the
 * line is still worth keeping, at the neutral level -- never
 * BugseeLogLevelInvalid, which is not a level a log line can honestly carry.
 */
- (void)testOutOfRangeLevelBecomesInfo {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];
  BGSRNFullWrapperChannel *channel = [BGSRNFullWrapperChannel new];
  holder.channel = channel;

  const NSInteger wires[] = { 0, 6 };
  for (size_t i = 0; i < sizeof(wires) / sizeof(wires[0]); i++) {
    [holder logMessage:[NSString stringWithFormat:@"level %ld", (long)wires[i]] level:wires[i]];
  }

  XCTAssertEqual(channel.lines.count, (NSUInteger)2);
  for (NSDictionary *line in channel.lines) {
    XCTAssertEqual([line[@"level"] integerValue], (NSInteger)BugseeLogLevelInfo);
    XCTAssertNotEqual([line[@"level"] integerValue], (NSInteger)BugseeLogLevelInvalid);
  }
}

/**
 * `NO` would also skip the SDK's own network sanitizer, not only the app's
 * filter -- there is no case where this wrapper wants that.
 */
- (void)testNetworkEventsAlwaysRequireFiltering {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];
  BGSRNFullWrapperChannel *channel = [BGSRNFullWrapperChannel new];
  holder.channel = channel;
  BugseeNetworkEvent *event = [self networkEvent];

  [holder addNetworkEvent:event];

  XCTAssertEqual(channel.events.count, (NSUInteger)1);
  XCTAssertEqualObjects(channel.events[0], event);
  XCTAssertEqual(channel.requiresFilteringCalls.count, (NSUInteger)1);
  XCTAssertTrue(channel.requiresFilteringCalls[0].boolValue);
}

/** Before registration delivers a channel there is nowhere to send anything. */
- (void)testNoChannelIsANoOp {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];

  XCTAssertNoThrow([holder logMessage:@"nobody listening" level:3]);
  XCTAssertNoThrow([holder addNetworkEvent:[self networkEvent]]);
}

/**
 * Every channel method is @optional; a channel that implements neither must
 * not crash the caller.
 */
- (void)testAChannelWithoutTheSelectorIsANoOp {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];
  holder.channel = [BGSRNChannelWithoutTheSelector new];

  XCTAssertNoThrow([holder logMessage:@"nobody home" level:3]);
  XCTAssertNoThrow([holder addNetworkEvent:[self networkEvent]]);
}

/** Clearing the channel retires it: nothing sent afterwards reaches it. */
- (void)testClearingRetiresTheChannel {
  BGSRNWrapperChannelHolder *holder = [BGSRNWrapperChannelHolder new];
  BGSRNFullWrapperChannel *channel = [BGSRNFullWrapperChannel new];
  holder.channel = channel;

  holder.channel = nil;
  [holder logMessage:@"after clear" level:3];
  [holder addNetworkEvent:[self networkEvent]];

  XCTAssertEqual(channel.lines.count, (NSUInteger)0);
  XCTAssertEqual(channel.events.count, (NSUInteger)0);
}

@end
