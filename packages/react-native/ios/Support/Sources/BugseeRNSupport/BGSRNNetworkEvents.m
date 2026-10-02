#import "BGSRNNetworkEvents.h"

static NSString *const BGSRNNetworkEventMechanism = @"react-native";

static BOOL BGSRNIsStringOrNull(id value) {
  return value == nil || value == [NSNull null] || [value isKindOfClass:[NSString class]];
}

static NSString *BGSRNStringOrNil(id value) {
  if ([value isKindOfClass:[NSString class]]) {
    return value;
  }
  return nil;
}

/// `completed` is the name JS and the device test use. The SDK's wire name
/// for that stage is `complete`, `BugseeNetworkEventComplete`.
static BOOL BGSRNNetworkStage(id name, BGSNetworkEventStage *out) {
  if (name == nil || name == [NSNull null] || [name isEqual:@"completed"] || [name isEqual:@"complete"]) {
    *out = BGSNetworkEventStageRequestCompleted;
    return YES;
  }
  if (![name isKindOfClass:[NSString class]]) {
    return NO;
  }
  NSString *wire = name;
  if ([wire isEqualToString:@"started"]) {
    wire = @"before";
  } else if ([wire isEqualToString:@"aborted"] || [wire isEqualToString:@"cancel"]) {
    wire = @"abort";
  } else if ([wire isEqualToString:@"timings"]) {
    wire = @"timing";
  }
  if ([wire isEqualToString:@"before"]) {
    *out = BGSNetworkEventStageRequestStarted;
  } else if ([wire isEqualToString:@"redirect"]) {
    *out = BGSNetworkEventStageRedirect;
  } else if ([wire isEqualToString:@"error"]) {
    *out = BGSNetworkEventStageRequestErrored;
  } else if ([wire isEqualToString:@"abort"]) {
    *out = BGSNetworkEventStageRequestAborted;
  } else if ([wire isEqualToString:@"timing"]) {
    *out = BGSNetworkEventStageRequestTimingsReceived;
  } else if ([wire isEqualToString:@"websocket"]) {
    *out = BGSNetworkEventStageWebSocket;
  } else {
    return NO;
  }
  return YES;
}

static NSString *BGSRNBugseeEventType(BGSNetworkEventStage stage) {
  switch (stage) {
    case BGSNetworkEventStageRequestStarted:
      return BugseeNetworkEventBegin;
    case BGSNetworkEventStageRequestAborted:
      return BugseeNetworkEventCancel;
    case BGSNetworkEventStageRequestErrored:
      return BugseeNetworkEventError;
    case BGSNetworkEventStageWebSocket:
      return BugseeWebSocketEventMessage;
    case BGSNetworkEventStageRequestCompleted:
    case BGSNetworkEventStageRedirect:
    case BGSNetworkEventStageRequestTimingsReceived:
      return BugseeNetworkEventComplete;
  }
  return BugseeNetworkEventComplete;
}

static BOOL BGSRNHeaders(id value, NSDictionary<NSString *, NSString *> *__autoreleasing *out) {
  if (value == nil || value == [NSNull null]) {
    *out = nil;
    return YES;
  }
  if (![value isKindOfClass:[NSDictionary class]]) {
    return NO;
  }
  NSMutableDictionary<NSString *, NSString *> *map = [NSMutableDictionary dictionary];
  for (id key in (NSDictionary *)value) {
    id item = ((NSDictionary *)value)[key];
    if (![key isKindOfClass:[NSString class]] || ![item isKindOfClass:[NSString class]]) {
      return NO;
    }
    map[key] = item;
  }
  *out = map;
  return YES;
}

BGSRNNetworkEventOutcome BGSRNRecordNetworkEvent(NSDictionary<NSString *, id> *object,
                                                 BGSRNNetworkEventSubmit submit,
                                                 NSTimeInterval nowMs) {
  NSString *url = BGSRNStringOrNil(object[@"url"]);
  NSString *method = BGSRNStringOrNil(object[@"method"]);
  if (url == nil || method == nil) {
    return BGSRNNetworkEventOutcomeRejected;
  }
  BGSNetworkEventStage stage = BGSNetworkEventStageRequestCompleted;
  if (!BGSRNNetworkStage(object[@"stage"], &stage)) {
    return BGSRNNetworkEventOutcomeRejected;
  }
  if (object[@"id"] != nil && !BGSRNIsStringOrNull(object[@"id"])) {
    return BGSRNNetworkEventOutcomeRejected;
  }
  for (NSString *key in @[@"body", @"statusText", @"errorDescription", @"errorShortMessage", @"redirectedFromURL"]) {
    if (object[key] != nil && !BGSRNIsStringOrNull(object[key])) {
      return BGSRNNetworkEventOutcomeRejected;
    }
  }
  if (object[@"responseCode"] != nil && object[@"responseCode"] != [NSNull null]
      && ![object[@"responseCode"] isKindOfClass:[NSNumber class]]) {
    return BGSRNNetworkEventOutcomeRejected;
  }
  NSDictionary<NSString *, NSString *> *headers = nil;
  const BOOL hasHeaders = object[@"headers"] != nil;
  if (hasHeaders && !BGSRNHeaders(object[@"headers"], &headers)) {
    return BGSRNNetworkEventOutcomeRejected;
  }
  if (object[@"error"] != nil && object[@"error"] != [NSNull null]
      && ![object[@"error"] isKindOfClass:[NSDictionary class]]) {
    return BGSRNNetworkEventOutcomeRejected;
  }

  NSString *eventId = BGSRNStringOrNil(object[@"id"]);
  if (eventId.length == 0) {
    eventId = [NSUUID UUID].UUIDString;
  }
  NSData *body = nil;
  NSString *bodyText = BGSRNStringOrNil(object[@"body"]);
  if (bodyText != nil) {
    body = [bodyText dataUsingEncoding:NSUTF8StringEncoding];
  }
  id errorValue = object[@"error"];
  NSDictionary *error = [errorValue isKindOfClass:[NSDictionary class]] ? errorValue : nil;
  const NSInteger responseCode = (object[@"responseCode"] != nil && object[@"responseCode"] != [NSNull null])
      ? [object[@"responseCode"] integerValue]
      : 0;
  const BugseeNetworkType kind = stage == BGSNetworkEventStageWebSocket ? BugseeWebSocket : BugseeNetwork;
  BugseeNetworkEvent *event = [BugseeNetworkEvent eventWithID:eventId
                                                    HTTPmethod:method
                                                          type:kind
                                               bugseeEventType:BGSRNBugseeEventType(stage)
                                                           url:url
                                                 redirectedUrl:BGSRNStringOrNil(object[@"redirectedFromURL"])
                                                          body:body
                                                         error:error
                                                       headers:hasHeaders ? headers : nil
                                                  noBodyReason:nil
                                                      dataSize:(int64_t)body.length
                                                  responseCode:responseCode];
  if (event == nil) {
    return BGSRNNetworkEventOutcomeNoEvent;
  }
  event.mechanism = BGSRNNetworkEventMechanism;
  event.timestamp = nowMs;
  // Filtering is required. The one-argument addNetworkEvent: passes NO.
  submit(event, YES);
  return BGSRNNetworkEventOutcomeAdded;
}
