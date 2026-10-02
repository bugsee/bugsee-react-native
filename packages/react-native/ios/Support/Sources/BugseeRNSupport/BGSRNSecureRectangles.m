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

/// One coordinate moved by the origin, rounded outward: down for a left or top
/// edge, up for a right or bottom one, so the region can only grow. Saturates
/// at the int32 range.
static int32_t BGSRNMovedCoordinate(int32_t value, NSUInteger index, CGPoint origin) {
  const BOOL isX = index % 2 == 0;
  const BOOL isLeadingEdge = index % kCoordinatesPerRectangle < 2;
  const double moved = (double)value + (isX ? origin.x : origin.y);
  const double rounded = isLeadingEdge ? floor(moved) : ceil(moved);
  if (rounded >= (double)INT32_MAX) {
    return INT32_MAX;
  }
  if (rounded <= (double)INT32_MIN) {
    return INT32_MIN;
  }
  return (int32_t)rounded;
}

/// `raw` (int32 coordinates) with every coordinate moved by `origin`.
static NSData *BGSRNMovedCoordinates(NSData *raw, CGPoint origin) {
  if (origin.x == 0 && origin.y == 0) {
    return raw;
  }
  const NSUInteger count = raw.length / sizeof(int32_t);
  NSMutableData *moved = [NSMutableData dataWithLength:raw.length];
  const int32_t *in = (const int32_t *)raw.bytes;
  int32_t *out = (int32_t *)moved.mutableBytes;
  for (NSUInteger i = 0; i < count; i++) {
    out[i] = BGSRNMovedCoordinate(in[i], i, origin);
  }
  return [moved copy];
}

@implementation BGSRNSecureRectangles {
  /// display -> the coordinates JS last published for it, in its window's
  /// points, as NSData of int32.
  NSMutableDictionary<NSNumber *, NSData *> *_rawByDisplay;
  /// display -> the window's place on that display's screen, a CGPoint.
  NSMutableDictionary<NSNumber *, NSValue *> *_originByDisplay;
  /// display -> the coordinates served to the SDK: the raw ones moved by the
  /// origin. Absent until something is published for the display.
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
    _rawByDisplay = [NSMutableDictionary dictionary];
    _originByDisplay = [NSMutableDictionary dictionary];
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
  _rawByDisplay[key] = published;
  [self serveLocked:key];
  [_lock unlock];

  return YES;
}

- (void)setOrigin:(CGPoint)origin forDisplay:(NSInteger)display {
  NSNumber *key = @(display);
  [_lock lock];
  // The usual case: re-read on every pull, the window has not moved.
  CGPoint previous = CGPointZero;
  NSValue *recorded = _originByDisplay[key];
  [recorded getValue:&previous size:sizeof(previous)];
  if (recorded != nil && CGPointEqualToPoint(previous, origin)) {
    [_lock unlock];
    return;
  }
  _originByDisplay[key] = [NSValue valueWithBytes:&origin objCType:@encode(CGPoint)];
  // Nothing published yet: the display keeps reporting the empty set at its
  // initial version, and the origin applies to whatever comes.
  if (_rawByDisplay[key] != nil) {
    [self serveLocked:key];
  }
  [_lock unlock];
}

/// Moves the display's raw coordinates by its origin and serves them, moving
/// the version only when what is served changes. Called with `_lock` held.
- (void)serveLocked:(NSNumber *)key {
  CGPoint origin = CGPointZero;
  [_originByDisplay[key] getValue:&origin size:sizeof(origin)];
  NSData *served = BGSRNMovedCoordinates(_rawByDisplay[key], origin);
  NSData *previous = _coordinatesByDisplay[key];
  if (previous == nil || ![previous isEqualToData:served]) {
    const int32_t currentVersion =
        previous == nil ? kInitialVersion : _versionsByDisplay[key].intValue;
    _coordinatesByDisplay[key] = served;
    _versionsByDisplay[key] = @(BGSRNNextVersion(currentVersion));
  }
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
