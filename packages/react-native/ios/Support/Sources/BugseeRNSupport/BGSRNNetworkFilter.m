#import "BGSRNNetworkFilter.h"

static id BGSRNJSONOrNull(id value) {
  return value == nil ? [NSNull null] : value;
}

NSString *BGSRNNetworkEventJSON(BugseeNetworkEvent *event) {
  const BOOL websocket = event.type == BugseeWebSocket;
  const BOOL udp = event.type == BugseeUDPSocket;
  NSString *stage = websocket ? @"websocket"
                  : udp ? @"udpsocket"
                        : event.bugseeNetworkEventType;
  NSString *websocketEvent = websocket ? event.bugseeNetworkEventType : nil;
  NSMutableDictionary *headers = nil;
  if ([event.headers isKindOfClass:[NSDictionary class]]) {
    headers = [NSMutableDictionary dictionary];
    [event.headers enumerateKeysAndObjectsUsingBlock:^(id key, id obj, BOOL *stop) {
      if ([key isKindOfClass:[NSString class]] && [obj isKindOfClass:[NSString class]]) {
        headers[key] = obj;
      }
    }];
  }
  NSMutableDictionary *payload = [@{
    @"id" : BGSRNJSONOrNull(event.ID),
    @"url" : BGSRNJSONOrNull(event.url),
    @"method" : BGSRNJSONOrNull(event.method),
    @"headers" : headers != nil ? headers : [NSNull null],
    @"mechanism" : BGSRNJSONOrNull(event.mechanism),
    @"type" : BGSRNJSONOrNull(stage),
    @"websocketEvent" : BGSRNJSONOrNull(websocketEvent),
    @"responseCode" : @(event.responseCode),
    @"redirectedFromURL" : BGSRNJSONOrNull(event.redirectedFromURL),
    @"error" : BGSRNJSONOrNull(event.error),
  } mutableCopy];
  // Non-empty bytes that are not UTF-8 stay off the snapshot. JSON null is
  // only for a body that is actually nil or empty; a present null is a clear.
  if (event.body.length > 0) {
    NSString *text = [[NSString alloc] initWithData:event.body encoding:NSUTF8StringEncoding];
    if (text != nil) {
      payload[@"body"] = text;
    }
  } else {
    payload[@"body"] = [NSNull null];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (data == nil) {
    return nil;
  }
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

BOOL BGSRNApplyNetworkReplacement(BugseeNetworkEvent *event, NSString *eventJson) {
  NSData *data = [eventJson dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) {
    return NO;
  }
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    return NO;
  }
  NSDictionary *object = parsed;
  if (object[@"url"] != nil) {
    id url = object[@"url"];
    if (url == [NSNull null]) {
      event.url = nil;
      if (event.url != nil) {
        return NO;
      }
    } else if ([url isKindOfClass:[NSString class]]) {
      event.url = url;
      if (![event.url isEqualToString:url]) {
        return NO;
      }
    } else {
      return NO;
    }
  }
  if (object[@"body"] != nil) {
    id body = object[@"body"];
    if (body == [NSNull null]) {
      event.body = nil;
      if (event.body != nil) {
        return NO;
      }
    } else if ([body isKindOfClass:[NSString class]]) {
      NSData *encoded = [(NSString *)body dataUsingEncoding:NSUTF8StringEncoding];
      event.body = encoded;
      NSString *roundTrip = event.body == nil
          ? nil
          : [[NSString alloc] initWithData:event.body encoding:NSUTF8StringEncoding];
      if (![roundTrip isEqualToString:body]) {
        return NO;
      }
    } else {
      return NO;
    }
  }
  if (object[@"headers"] != nil) {
    id headers = object[@"headers"];
    if (headers == [NSNull null]) {
      event.headers = nil;
      if (event.headers != nil) {
        return NO;
      }
    } else if ([headers isKindOfClass:[NSDictionary class]]) {
      NSMutableDictionary *map = [NSMutableDictionary dictionary];
      for (id key in (NSDictionary *)headers) {
        id value = ((NSDictionary *)headers)[key];
        if (![key isKindOfClass:[NSString class]] || ![value isKindOfClass:[NSString class]]) {
          return NO;
        }
        map[key] = value;
      }
      event.headers = map;
      if (![event.headers isEqualToDictionary:map]) {
        return NO;
      }
    } else {
      return NO;
    }
  }
  if (object[@"redirectedFromURL"] != nil) {
    id redirected = object[@"redirectedFromURL"];
    if (redirected == [NSNull null]) {
      event.redirectedFromURL = nil;
      if (event.redirectedFromURL != nil) {
        return NO;
      }
    } else if ([redirected isKindOfClass:[NSString class]]) {
      event.redirectedFromURL = redirected;
      if (![event.redirectedFromURL isEqualToString:redirected]) {
        return NO;
      }
    } else {
      return NO;
    }
  }
  if (object[@"error"] != nil) {
    id error = object[@"error"];
    if (error == [NSNull null]) {
      event.error = nil;
      if (event.error != nil) {
        return NO;
      }
    } else if ([error isKindOfClass:[NSDictionary class]]) {
      event.error = error;
      if (![event.error isEqualToDictionary:error]) {
        return NO;
      }
    } else {
      return NO;
    }
  }
  return YES;
}
