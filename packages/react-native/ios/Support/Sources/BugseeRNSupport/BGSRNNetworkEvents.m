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
/// for that stage is `complete`.
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

@protocol BGSRNNetworkEventExtras <NSObject>
@property (nonatomic, copy, nullable) NSString *redirectedFromURL;
@property (nonatomic, copy, nullable) NSDictionary *error;
@end

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
                                                 BGSRNNetworkEventCreate create,
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
  if (create == nil) {
    return BGSRNNetworkEventOutcomeNoEvent;
  }
  id created = nil;
  @try {
    created = create(nowMs, stage, BGSRNStringOrNil(object[@"id"]), BGSRNNetworkEventMechanism, method);
  } @catch (NSException *exception) {
    return BGSRNNetworkEventOutcomeNoEvent;
  }
  if (created == nil) {
    return BGSRNNetworkEventOutcomeNoEvent;
  }
  id<BGSNetworkEventContract> event = created;
  event.url = url;
  if (object[@"body"] != nil) {
    event.body = BGSRNStringOrNil(object[@"body"]);
  }
  if (hasHeaders) {
    event.headers = headers;
  }
  if (object[@"responseCode"] != nil && object[@"responseCode"] != [NSNull null]) {
    event.responseCode = [object[@"responseCode"] integerValue];
  }
  if (object[@"statusText"] != nil) {
    event.statusText = BGSRNStringOrNil(object[@"statusText"]);
  }
  if (object[@"errorDescription"] != nil) {
    event.errorDescription = BGSRNStringOrNil(object[@"errorDescription"]);
  }
  if (object[@"errorShortMessage"] != nil) {
    event.errorShortMessage = BGSRNStringOrNil(object[@"errorShortMessage"]);
  }
  if (object[@"redirectedFromURL"] != nil && [event respondsToSelector:@selector(setRedirectedFromURL:)]) {
    ((id<BGSRNNetworkEventExtras>)event).redirectedFromURL = BGSRNStringOrNil(object[@"redirectedFromURL"]);
  }
  if (object[@"error"] != nil && [event respondsToSelector:@selector(setError:)]) {
    id error = object[@"error"];
    ((id<BGSRNNetworkEventExtras>)event).error = error == [NSNull null] ? nil : error;
  }
  // Filtering is required. An installed setNetworkFilter must see this event.
  submit(event, YES);
  return BGSRNNetworkEventOutcomeAdded;
}
