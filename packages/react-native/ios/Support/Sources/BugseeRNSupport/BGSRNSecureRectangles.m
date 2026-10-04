#import "BGSRNSecureRectangles.h"

/// Four coordinates per rectangle: left, top, right, bottom.
static const NSUInteger kCoordinatesPerRectangle = 4;

/// Precedes the rectangles in every buffer: the version and the count.
static const NSUInteger kHeaderInts = 2;

/// What a display reports before anything is secured. Any value works as long
/// as it is stable; the SDK only ever compares it against what it saw last.
static const int32_t kInitialVersion = 1;

/// The activity / main React root's surface key. Legacy writers that do not
/// name a surface land here.
const NSInteger BGSRNSecureMainSurface = 0;

/// Steps the version, skipping the value that means "nothing secured yet":
/// landing back on it would make a real set look identical to the empty one to
/// an SDK that had only ever seen the latter. Wrapping takes 2^31 changes, so
/// this matters in principle rather than in practice.
static int32_t BGSRNNextVersion(int32_t current) {
  const int32_t next = (int32_t)((uint32_t)current + 1u);
  return next == kInitialVersion ? kInitialVersion + 1 : next;
}

static int32_t BGSRNSaturatedAdd(int32_t a, int32_t b) {
  const int64_t sum = (int64_t)a + (int64_t)b;
  if (sum > INT32_MAX) {
    return INT32_MAX;
  }
  if (sum < INT32_MIN) {
    return INT32_MIN;
  }
  return (int32_t)sum;
}

/// One surface's raw measurements and the origin that places them.
@interface BGSRNSecureLane : NSObject
@property (nonatomic, copy) NSData *raw;
@property (nonatomic, assign) int32_t originX;
@property (nonatomic, assign) int32_t originY;
@property (nonatomic, copy, readonly) NSData *coordinates;
@end

@implementation BGSRNSecureLane

- (instancetype)initWithRaw:(NSData *)raw originX:(int32_t)originX originY:(int32_t)originY {
  self = [super init];
  if (self) {
    _raw = [raw copy] ?: [NSData data];
    _originX = originX;
    _originY = originY;
    const NSUInteger count = _raw.length / sizeof(int32_t);
    if (count == 0) {
      _coordinates = [NSData data];
    } else {
      NSMutableData *moved = [NSMutableData dataWithLength:count * sizeof(int32_t)];
      const int32_t *in = (const int32_t *)_raw.bytes;
      int32_t *out = (int32_t *)moved.mutableBytes;
      for (NSUInteger i = 0; i < count; i++) {
        out[i] = BGSRNSaturatedAdd(in[i], (i % 2 == 0) ? originX : originY);
      }
      _coordinates = [moved copy];
    }
  }
  return self;
}

@end

@implementation BGSRNSecureRectangles {
  /// display -> (surface -> lane). Surfaces sorted by key when serving.
  NSMutableDictionary<NSNumber *, NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *> *_lanesByDisplay;
  /// display -> its current version.
  NSMutableDictionary<NSNumber *, NSNumber *> *_versionsByDisplay;
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
    _lanesByDisplay = [NSMutableDictionary dictionary];
    _versionsByDisplay = [NSMutableDictionary dictionary];
    _lock = [[NSLock alloc] init];
  }
  return self;
}

- (BOOL)setCoordinates:(const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display {
  return [self setCoordinates:coordinates count:count forDisplay:display surface:BGSRNSecureMainSurface];
}

- (BOOL)setCoordinates:(const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display
               surface:(NSInteger)surface {
  if (count % kCoordinatesPerRectangle != 0) {
    return NO;
  }
  if (coordinates == NULL && count > 0) {
    return NO;
  }

  NSData *published = count == 0
      ? [NSData data]
      : [NSData dataWithBytes:coordinates length:count * sizeof(int32_t)];

  NSNumber *displayKey = @(display);
  NSNumber *surfaceKey = @(surface);

  [_lock lock];
  NSData *previousServed = [self servedCoordinatesForDisplayLocked:display];
  NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *lanes = _lanesByDisplay[displayKey];
  if (lanes == nil) {
    lanes = [NSMutableDictionary dictionary];
    _lanesByDisplay[displayKey] = lanes;
  }
  BGSRNSecureLane *prior = lanes[surfaceKey];
  int32_t originX = prior ? prior.originX : 0;
  int32_t originY = prior ? prior.originY : 0;
  lanes[surfaceKey] = [[BGSRNSecureLane alloc] initWithRaw:published originX:originX originY:originY];
  NSData *nextServed = [self servedCoordinatesForDisplayLocked:display];
  if (![previousServed isEqualToData:nextServed]) {
    const int32_t currentVersion = _versionsByDisplay[displayKey]
                                       ? _versionsByDisplay[displayKey].intValue
                                       : kInitialVersion;
    _versionsByDisplay[displayKey] = @(BGSRNNextVersion(currentVersion));
  }
  [_lock unlock];

  return YES;
}

- (void)setOriginX:(int32_t)originX originY:(int32_t)originY forDisplay:(NSInteger)display {
  [self setOriginX:originX originY:originY forDisplay:display surface:BGSRNSecureMainSurface];
}

- (void)setOriginX:(int32_t)originX
           originY:(int32_t)originY
        forDisplay:(NSInteger)display
           surface:(NSInteger)surface {
  NSNumber *displayKey = @(display);
  NSNumber *surfaceKey = @(surface);

  [_lock lock];
  NSData *previousServed = [self servedCoordinatesForDisplayLocked:display];
  NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *lanes = _lanesByDisplay[displayKey];
  if (lanes == nil) {
    lanes = [NSMutableDictionary dictionary];
    _lanesByDisplay[displayKey] = lanes;
  }
  BGSRNSecureLane *prior = lanes[surfaceKey];
  NSData *raw = prior ? prior.raw : [NSData data];
  lanes[surfaceKey] = [[BGSRNSecureLane alloc] initWithRaw:raw originX:originX originY:originY];
  NSData *nextServed = [self servedCoordinatesForDisplayLocked:display];
  if (![previousServed isEqualToData:nextServed]) {
    const int32_t currentVersion = _versionsByDisplay[displayKey]
                                       ? _versionsByDisplay[displayKey].intValue
                                       : kInitialVersion;
    _versionsByDisplay[displayKey] = @(BGSRNNextVersion(currentVersion));
  }
  [_lock unlock];
}

/// Caller holds `_lock`.
- (NSData *)servedCoordinatesForDisplayLocked:(NSInteger)display {
  NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *lanes = _lanesByDisplay[@(display)];
  if (lanes.count == 0) {
    return [NSData data];
  }
  NSArray<NSNumber *> *keys = [lanes.allKeys sortedArrayUsingSelector:@selector(compare:)];
  NSMutableData *merged = [NSMutableData data];
  for (NSNumber *key in keys) {
    [merged appendData:lanes[key].coordinates];
  }
  return [merged copy];
}

- (NSData *)snapshotForDisplay:(NSInteger)display {
  NSNumber *key = @(display);

  [_lock lock];
  NSData *coordinates = [self servedCoordinatesForDisplayLocked:display];
  // Lanes can exist without a version entry: an origin-only write that leaves
  // the served buffer empty deliberately does not bump. Messaging a missing
  // NSNumber yields 0, which is not the empty-set version (kInitialVersion).
  const int32_t version = _versionsByDisplay[key]
                              ? _versionsByDisplay[key].intValue
                              : kInitialVersion;
  [_lock unlock];

  const NSUInteger coordinateCount = coordinates.length / sizeof(int32_t);

  NSMutableData *packed =
      [NSMutableData dataWithLength:(kHeaderInts + coordinateCount) * sizeof(int32_t)];
  int32_t *out = (int32_t *)packed.mutableBytes;
  out[0] = (int32_t)CFSwapInt32HostToLittle((uint32_t)version);
  out[1] = (int32_t)CFSwapInt32HostToLittle(
      (uint32_t)(coordinateCount / kCoordinatesPerRectangle));

  if (coordinateCount > 0) {
    const int32_t *in = (const int32_t *)coordinates.bytes;
    for (NSUInteger i = 0; i < coordinateCount; i++) {
      out[kHeaderInts + i] = (int32_t)CFSwapInt32HostToLittle((uint32_t)in[i]);
    }
  }

  return [packed copy];
}

@end
