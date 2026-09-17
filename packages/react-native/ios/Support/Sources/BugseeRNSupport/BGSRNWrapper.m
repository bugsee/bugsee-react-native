#import "BGSRNWrapper.h"

static NSString *const BGSRNUnknown = @"unknown";

static NSString *BGSRNStringOr(NSDictionary *source, NSString *key, NSString *fallback) {
  id value = source[key];
  return [value isKindOfClass:[NSString class]] && [value length] > 0 ? value : fallback;
}

@implementation BGSRNWrapper

+ (instancetype)wrapperWithIdentity:(NSDictionary *)identity {
  BGSRNWrapper *wrapper = [[BGSRNWrapper alloc] init];
  if (wrapper == nil) {
    return nil;
  }
  NSDictionary *source = [identity isKindOfClass:[NSDictionary class]] ? identity : @{};

  wrapper->_wrapperType = [BGSRNStringOr(source, @"type", BGSRNUnknown) copy];
  wrapper->_wrapperVersion = [BGSRNStringOr(source, @"version", BGSRNUnknown) copy];

  id build = source[@"build"];
  wrapper->_wrapperBuild =
      [build isKindOfClass:[NSString class]] ? [build copy] : nil;

  // The SDK types context as string-to-string. A non-string value is dropped
  // rather than described: a number rendered as "1" is indistinguishable from
  // a version the wrapper actually reported.
  id rawContext = source[@"context"];
  if ([rawContext isKindOfClass:[NSDictionary class]]) {
    NSMutableDictionary<NSString *, NSString *> *context = [NSMutableDictionary dictionary];
    [(NSDictionary *)rawContext enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
      if ([key isKindOfClass:[NSString class]] && [value isKindOfClass:[NSString class]]) {
        context[key] = value;
      }
    }];
    wrapper->_context = [context copy];
  }

  return wrapper;
}

@end
