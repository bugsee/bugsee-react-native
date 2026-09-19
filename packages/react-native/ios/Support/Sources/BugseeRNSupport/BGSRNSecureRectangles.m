#import "BGSRNSecureRectangles.h"

/// Four coordinates per rectangle: left, top, right, bottom.
static const NSUInteger kCoordinatesPerRectangle = 4;

/// Precedes the rectangles in every buffer: the version and the count.
static const NSUInteger kHeaderInts = 2;

/// What a display reports before anything is secured. Any value works as long
/// as it is stable; the SDK only ever compares it against what it saw last.
static const int32_t kInitialVersion = 1;

/// Steps the version, skipping the value that means "nothing secured yet":
/// landing back on it would make a real set look identical to the empty one to
/// an SDK that had only ever seen the latter. Wrapping takes 2^31 changes, so
/// this matters in principle rather than in practice.
static int32_t BGSRNNextVersion(int32_t current) {
  const int32_t next = (int32_t)((uint32_t)current + 1u);
  return next == kInitialVersion ? kInitialVersion + 1 : next;
}

@implementation BGSRNSecureRectangles {
  /// display -> the coordinates last published for it, as NSData of int32.
  NSMutableDictionary<NSNumber *, NSData *> *_coordinatesByDisplay;
  /// display -> its current version.
  NSMutableDictionary<NSNumber *, NSNumber *> *_versionsByDisplay;
  /// Serialises the JS-thread write against the main-thread pull. A plain lock
  /// rather than a queue: the pull happens on the SDK's own thread 2-3 times a
  /// second and must not be made to hop.
  NSLock *_lock;
}

+ (BGSRNSecureRectangles *)shared {
  static BGSRNSecureRectangles *shared = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [[BGSRNSecureRectangles alloc] init];
  });
  return shared;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _coordinatesByDisplay = [NSMutableDictionary dictionary];
    _versionsByDisplay = [NSMutableDictionary dictionary];
    _lock = [[NSLock alloc] init];
  }
  return self;
}

- (BOOL)setCoordinates:(const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display {
  if (count % kCoordinatesPerRectangle != 0) {
    return NO;
  }
  if (coordinates == NULL && count > 0) {
    return NO;
  }

  // Copied on the way in: the caller keeps its buffer, and a later write
  // through it would edit a snapshot the SDK is reading.
  NSData *published = count == 0
      ? [NSData data]
      : [NSData dataWithBytes:coordinates length:count * sizeof(int32_t)];

  NSNumber *key = @(display);
  [_lock lock];
  NSData *previous = _coordinatesByDisplay[key];
  if (previous == nil || ![previous isEqualToData:published]) {
    const int32_t currentVersion =
        previous == nil ? kInitialVersion : _versionsByDisplay[key].intValue;
    _coordinatesByDisplay[key] = published;
    _versionsByDisplay[key] = @(BGSRNNextVersion(currentVersion));
  }
  [_lock unlock];

  return YES;
}

- (NSData *)snapshotForDisplay:(NSInteger)display {
  NSNumber *key = @(display);

  [_lock lock];
  NSData *coordinates = _coordinatesByDisplay[key];
  const int32_t version =
      coordinates == nil ? kInitialVersion : _versionsByDisplay[key].intValue;
  [_lock unlock];

  const NSUInteger coordinateCount =
      coordinates == nil ? 0 : coordinates.length / sizeof(int32_t);

  NSMutableData *packed =
      [NSMutableData dataWithLength:(kHeaderInts + coordinateCount) * sizeof(int32_t)];
  int32_t *out = (int32_t *)packed.mutableBytes;
  // The SDK reads raw int32s, so the encoding is explicit rather than whatever
  // this host happens to be.
  out[0] = (int32_t)CFSwapInt32HostToLittle((uint32_t)version);
  out[1] = (int32_t)CFSwapInt32HostToLittle(
      (uint32_t)(coordinateCount / kCoordinatesPerRectangle));

  if (coordinateCount > 0) {
    const int32_t *in = (const int32_t *)coordinates.bytes;
    for (NSUInteger i = 0; i < coordinateCount; i++) {
      out[kHeaderInts + i] = (int32_t)CFSwapInt32HostToLittle((uint32_t)in[i]);
    }
  }

  // Immutable to the caller: the SDK may hold it across our next write.
  return [packed copy];
}

@end
