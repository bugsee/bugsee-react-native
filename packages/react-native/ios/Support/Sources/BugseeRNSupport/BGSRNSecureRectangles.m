#import "BGSRNSecureRectangles.h"

#import <os/log.h>

/// Four coordinates per rectangle: left, top, right, bottom.
static const NSUInteger kCoordinatesPerRectangle = 4;

/// Precedes the rectangles in every buffer: the version and the count.
static const NSUInteger kHeaderInts = 2;

/// What a display reports before anything is secured. Any value works as long
/// as it is stable; the SDK only ever compares it against what it saw last.
static const int32_t kInitialVersion = 1;

const NSInteger BGSRNSecureMainSurface = 0;

const int32_t BGSRNSecureFallbackDisplaySize = 16384;

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

/// One surface's raw measurements and the origin that places them. Immutable:
/// a change replaces the lane.
@interface BGSRNSecureLane : NSObject
@property (nonatomic, copy, readonly) NSData *raw;
@property (nonatomic, assign, readonly) CGPoint origin;
@property (nonatomic, assign, readonly) BOOL originKnown;
/// What the SDK is served for this lane.
@property (nonatomic, copy, readonly) NSData *served;
@end

@implementation BGSRNSecureLane

- (instancetype)initWithRaw:(NSData *)raw origin:(CGPoint)origin originKnown:(BOOL)originKnown {
  self = [super init];
  if (self) {
    _raw = [raw copy] ?: [NSData data];
    _origin = origin;
    _originKnown = originKnown;
    // An unknown origin is served as the whole display, sized at serve time.
    _served = _raw.length == 0 || !originKnown ? [NSData data] : BGSRNMovedCoordinates(_raw, origin);
  }
  return self;
}

@end

@implementation BGSRNSecureRectangles {
  /// display -> (surface -> lane). Served in surface-key order.
  NSMutableDictionary<NSNumber *, NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *> *_lanesByDisplay;
  /// display -> its screen's size in points, a CGSize, once recorded.
  NSMutableDictionary<NSNumber *, NSValue *> *_boundsByDisplay;
  /// display -> its current version. Absent until the served set first changes.
  NSMutableDictionary<NSNumber *, NSNumber *> *_versionsByDisplay;
  /// Serialises the JS-thread write against the main-thread pull. A plain lock
  /// rather than a queue: the pull happens on main once per captured frame and
  /// must not be made to hop.
  NSLock *_lock;
  /// The current JS runtime's claim; see `claimRuntime`. Under `_lock`.
  NSInteger _runtime;
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
    _boundsByDisplay = [NSMutableDictionary dictionary];
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
  return [self setCoordinates:coordinates
                        count:count
                   forDisplay:display
                      surface:surface
                      runtime:[self currentClaim]];
}

- (NSInteger)currentClaim {
  [_lock lock];
  const NSInteger claim = _runtime;
  [_lock unlock];
  return claim;
}

/// Whether `claim` is still the current runtime's. A stale one is logged at
/// debug, numbers only. Caller holds `_lock`.
- (BOOL)isCurrentLocked:(NSInteger)claim {
  if (claim == _runtime) {
    return YES;
  }
  os_log_debug(OS_LOG_DEFAULT, "BugseeRN secure write ignored: runtime claim %ld is stale, current %ld",
               (long)claim, (long)_runtime);
  return NO;
}

- (BOOL)setCoordinates:(const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display
               surface:(NSInteger)surface
               runtime:(NSInteger)claim {
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

  [_lock lock];
  // Under the same lock as claimRuntime and releaseRuntime: a write checked
  // here cannot land after a newer claim has dropped the lanes.
  if (![self isCurrentLocked:claim]) {
    [_lock unlock];
    return NO;
  }
  [self changeLaneLockedForDisplay:display
                           surface:surface
                            change:^BGSRNSecureLane *(BGSRNSecureLane *prior) {
                              return [[BGSRNSecureLane alloc] initWithRaw:published
                                                                   origin:prior.origin
                                                              originKnown:prior.originKnown];
                            }];
  [_lock unlock];

  return YES;
}

- (void)setOrigin:(CGPoint)origin forDisplay:(NSInteger)display {
  [self setOrigin:origin forDisplay:display surface:BGSRNSecureMainSurface];
}

- (void)setOrigin:(CGPoint)origin forDisplay:(NSInteger)display surface:(NSInteger)surface {
  [_lock lock];
  BGSRNSecureLane *current = _lanesByDisplay[@(display)][@(surface)];
  // The usual case: re-read on every pull, the window has not moved.
  if (current != nil && current.originKnown && CGPointEqualToPoint(current.origin, origin)) {
    [_lock unlock];
    return;
  }
  [self changeLaneLockedForDisplay:display
                           surface:surface
                            change:^BGSRNSecureLane *(BGSRNSecureLane *prior) {
                              return [[BGSRNSecureLane alloc] initWithRaw:prior.raw
                                                                   origin:origin
                                                              originKnown:YES];
                            }];
  [_lock unlock];
}

- (void)setDisplaySize:(CGSize)size forDisplay:(NSInteger)display {
  if (!(size.width > 0) || !(size.height > 0)) {
    return;
  }
  NSNumber *key = @(display);
  [_lock lock];
  CGSize previous = CGSizeZero;
  NSValue *recorded = _boundsByDisplay[key];
  [recorded getValue:&previous size:sizeof(previous)];
  if (recorded == nil || !CGSizeEqualToSize(previous, size)) {
    NSData *previousServed = [self servedLockedForDisplay:display];
    _boundsByDisplay[key] = [NSValue valueWithBytes:&size objCType:@encode(CGSize)];
    [self moveVersionLockedForDisplay:display ifServedDiffersFrom:previousServed];
  }
  [_lock unlock];
}

- (NSInteger)claimRuntime {
  [_lock lock];
  _runtime += 1;
  const NSInteger claim = _runtime;
  [self dropNonMainSurfacesLocked];
  [self emptyMainSurfaceLocked];
  [_lock unlock];
  return claim;
}

/// Empties the main surface's rectangles on every display, keeping its
/// origin: the old runtime's set must not outlive it, and a new runtime that
/// never publishes on the main surface would otherwise inherit it. Caller
/// holds `_lock`.
- (void)emptyMainSurfaceLocked {
  for (NSNumber *display in _lanesByDisplay.allKeys) {
    BGSRNSecureLane *main = _lanesByDisplay[display][@(BGSRNSecureMainSurface)];
    if (main == nil || main.raw.length == 0) {
      continue;
    }
    [self changeLaneLockedForDisplay:display.integerValue
                             surface:BGSRNSecureMainSurface
                              change:^BGSRNSecureLane *(BGSRNSecureLane *prior) {
                                return [[BGSRNSecureLane alloc] initWithRaw:[NSData data]
                                                                     origin:prior.origin
                                                                originKnown:prior.originKnown];
                              }];
  }
}

- (void)releaseRuntime:(NSInteger)claim {
  [_lock lock];
  if (claim == _runtime) {
    [self dropNonMainSurfacesLocked];
  }
  [_lock unlock];
}

/// Drops every surface but the main one, moving each display's version when
/// what it serves changes. Caller holds `_lock`.
- (void)dropNonMainSurfacesLocked {
  for (NSNumber *display in _lanesByDisplay.allKeys) {
    NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *lanes = _lanesByDisplay[display];
    NSData *previousServed = [self servedLockedForDisplay:display.integerValue];
    for (NSNumber *surface in lanes.allKeys) {
      if (surface.integerValue != BGSRNSecureMainSurface) {
        [lanes removeObjectForKey:surface];
      }
    }
    [self moveVersionLockedForDisplay:display.integerValue ifServedDiffersFrom:previousServed];
  }
}

- (NSArray<NSNumber *> *)surfacesForDisplay:(NSInteger)display {
  [_lock lock];
  NSMutableArray<NSNumber *> *surfaces = [NSMutableArray array];
  for (NSNumber *key in _lanesByDisplay[@(display)]) {
    if (key.integerValue != BGSRNSecureMainSurface) {
      [surfaces addObject:key];
    }
  }
  [_lock unlock];
  return [surfaces sortedArrayUsingSelector:@selector(compare:)];
}

- (void)dropSurfaceIfEmpty:(NSInteger)surface {
  if (surface == BGSRNSecureMainSurface) {
    return;
  }
  [_lock lock];
  for (NSNumber *display in _lanesByDisplay.allKeys) {
    BGSRNSecureLane *lane = _lanesByDisplay[display][@(surface)];
    if (lane != nil && lane.raw.length == 0) {
      // An empty lane serves nothing, so removing it leaves the version alone.
      [_lanesByDisplay[display] removeObjectForKey:@(surface)];
    }
  }
  [_lock unlock];
}

/// Replaces one lane and moves the display's version only when what is served
/// changes. Caller holds `_lock`.
- (void)changeLaneLockedForDisplay:(NSInteger)display
                           surface:(NSInteger)surface
                            change:(BGSRNSecureLane * (^)(BGSRNSecureLane *prior))change {
  NSNumber *displayKey = @(display);
  NSNumber *surfaceKey = @(surface);
  NSData *previousServed = [self servedLockedForDisplay:display];
  NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *lanes = _lanesByDisplay[displayKey];
  if (lanes == nil) {
    lanes = [NSMutableDictionary dictionary];
    _lanesByDisplay[displayKey] = lanes;
  }
  BGSRNSecureLane *prior = lanes[surfaceKey]
      ?: [[BGSRNSecureLane alloc] initWithRaw:[NSData data] origin:CGPointZero originKnown:NO];
  lanes[surfaceKey] = change(prior);
  [self moveVersionLockedForDisplay:display ifServedDiffersFrom:previousServed];
}

/// Steps the display's version when what it serves now differs from
/// `previousServed`. Caller holds `_lock`.
- (void)moveVersionLockedForDisplay:(NSInteger)display ifServedDiffersFrom:(NSData *)previousServed {
  NSNumber *displayKey = @(display);
  NSData *nextServed = [self servedLockedForDisplay:display];
  if (![previousServed isEqualToData:nextServed]) {
    const int32_t currentVersion = _versionsByDisplay[displayKey]
                                       ? _versionsByDisplay[displayKey].intValue
                                       : kInitialVersion;
    _versionsByDisplay[displayKey] = @(BGSRNNextVersion(currentVersion));
  }
}

/// Every lane's served coordinates, in surface-key order. A lane whose origin
/// is unknown serves one rectangle covering the display: its screen's size,
/// rounded up, or the fallback square before that is recorded. Caller holds
/// `_lock`.
- (NSData *)servedLockedForDisplay:(NSInteger)display {
  NSMutableDictionary<NSNumber *, BGSRNSecureLane *> *lanes = _lanesByDisplay[@(display)];
  if (lanes.count == 0) {
    return [NSData data];
  }
  NSValue *recorded = _boundsByDisplay[@(display)];
  CGSize size = CGSizeMake(BGSRNSecureFallbackDisplaySize, BGSRNSecureFallbackDisplaySize);
  [recorded getValue:&size size:sizeof(size)];
  const int32_t whole[4] = {0, 0, (int32_t)ceil(size.width), (int32_t)ceil(size.height)};
  NSMutableData *merged = [NSMutableData data];
  for (NSNumber *key in [lanes.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    BGSRNSecureLane *lane = lanes[key];
    if (lane.raw.length == 0) {
      continue;
    }
    if (lane.originKnown) {
      [merged appendData:lane.served];
    } else {
      [merged appendBytes:whole length:sizeof(whole)];
    }
  }
  return [merged copy];
}

- (NSData *)snapshotForDisplay:(NSInteger)display {
  NSNumber *key = @(display);

  [_lock lock];
  NSData *coordinates = [self servedLockedForDisplay:display];
  // Keyed off the version itself, not the lanes: an origin-only write creates
  // a lane without moving the version, and must still report the initial one.
  const int32_t version =
      _versionsByDisplay[key] ? _versionsByDisplay[key].intValue : kInitialVersion;
  [_lock unlock];

  const NSUInteger coordinateCount = coordinates.length / sizeof(int32_t);

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
