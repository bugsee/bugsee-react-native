#import "include/BGSRNAttributes.h"

const NSInteger BGSRNAttributeArchiveLimit = 1124;

@implementation BGSRNAttributes

+ (BOOL)setValue:(id)value
           forKey:(NSString *)key
           setter:(BOOL (^)(NSString *key, id value))setter
           getter:(id _Nullable (^)(NSString *key))getter {
  if (!setter(key, value)) {
    return NO;
  }
  id stored = getter(key);
  return stored != nil && [stored isEqual:value];
}

+ (NSDictionary<NSString *, id> *)readable:(nullable NSDictionary *)raw {
  NSMutableDictionary<NSString *, id> *result = [NSMutableDictionary dictionary];
  if (raw == nil) {
    return result;
  }
  [raw enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
    if (![key isKindOfClass:NSString.class]) {
      return;
    }
    NSString *name = (NSString *)key;
    if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) {
      // Kept as the same object -- not re-boxed -- so a CFBoolean's identity
      // survives the round trip; the SDK's own JSON writer decides
      // true/false vs. a number by that identity, not by value.
      result[name] = value;
    } else if ([value isKindOfClass:NSArray.class]) {
      NSMutableArray<NSString *> *strings = [NSMutableArray array];
      for (id element in (NSArray *)value) {
        if ([element isKindOfClass:NSString.class]) {
          [strings addObject:element];
        }
      }
      result[name] = strings;
    }
    // Anything else -- NSDate, NSData, a nested collection, ... -- has no JS
    // representation and is silently dropped.
  }];
  return result;
}

+ (nullable NSString *)identifier:(nullable NSString *)raw {
  return (raw == nil || raw.length == 0) ? nil : raw;
}

@end
