@import Foundation;

NS_ASSUME_NONNULL_BEGIN

/// The rectangles of a packed secure-rectangle buffer, `[version, count, l, t,
/// r, b, ...]`, read as the SDK reads them: little-endian, signed.
static inline NSArray<NSNumber *> *BGSRNServedCoordinates(NSData *packed) {
  NSMutableArray<NSNumber *> *out = [NSMutableArray array];
  const NSUInteger count = packed.length / sizeof(int32_t);
  for (NSUInteger i = 2; i < count; i++) {
    int32_t value = 0;
    [packed getBytes:&value range:NSMakeRange(i * sizeof(int32_t), sizeof(int32_t))];
    [out addObject:@((int32_t)CFSwapInt32LittleToHost((uint32_t)value))];
  }
  return out;
}

NS_ASSUME_NONNULL_END
