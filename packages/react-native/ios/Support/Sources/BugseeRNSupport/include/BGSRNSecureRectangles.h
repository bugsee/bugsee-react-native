#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The regions the app has asked Bugsee not to record, in the form the SDK
/// pulls them.
///
/// The SDK does not subscribe to changes. It asks on the MAIN thread, once per
/// captured frame and per report screenshot (and from the touch filter, at
/// most every 100 ms, while nothing captures), for a packed buffer of
/// little-endian `int32`
/// `[version, count, left, top, right, bottom, ...]`, and re-reads the
/// rectangles only when the version differs from the one it saw last. Two
/// properties follow, and both are load-bearing rather than cosmetic:
///
///  * any change to the set MUST move the version. A stale version is a
///    privacy defect in the dangerous direction — the SDK keeps redacting the
///    region the app has stopped considering secret, and records a newly
///    secret one in the clear until something else happens to move it;
///  * a no-op write must NOT move it, or the SDK re-reads on every frame.
///
/// The version is kept per display, because the SDK's freshness comparison is
/// per display: a change on one screen must not invalidate another's.
///
/// ## Threading
///
/// Writes arrive on the JS thread; the pull is on the main thread. Every
/// published value is an immutable `NSData` swapped in whole. The SDK's header
/// is explicit that a buffer rewritten by another thread while it reads is a
/// use-after-free, so nothing here ever republishes into a buffer it has
/// already handed out.
@interface BGSRNSecureRectangles : NSObject

/// The process-wide set of secured regions.
///
/// Deliberately not owned by a wrapper instance: the wrapper object is
/// replaced mid-session — registered once before launch and swapped when the
/// JS bridge comes up — and the regions an app marked secret must not be
/// forgotten when that happens.
@property (class, readonly) BGSRNSecureRectangles *shared;

/// Publishes `coordinates` as the secure set for `display`, as a flat list of
/// four-`int32` rectangles.
///
/// @param coordinates may be NULL only when `count` is 0.
/// @param count number of int32s, which must be a multiple of 4.
/// @return NO, publishing nothing, when `count` is not whole rectangles.
- (BOOL)setCoordinates:(nullable const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display;

/// Records where the window JS measures in sits on `display`'s screen, in
/// points, and serves every rectangle of that display moved by it.
///
/// JS measures with `measureInWindow`, in the window's points. The SDK wants
/// the screen's points (`BGSContracts.h`) and composes every window of the app
/// on the screen, so in a window away from the screen's origin (iPad Stage
/// Manager, the right-hand side of Split View, iPhone Duo side by side) an
/// unmoved rectangle lands that far up and left of the view it covers, and
/// the view is recorded in the clear. Android moves its rectangles by the
/// React root's display origin the same way.
///
/// The origin can be fractional. Left and top edges are moved and rounded
/// down, right and bottom ones up: a rectangle may grow by under a point,
/// never shrink. Edges saturate at the int32 range rather than wrap. The
/// version moves only when the served rectangles change, so re-recording the
/// same origin costs the SDK nothing.
- (void)setOrigin:(CGPoint)origin forDisplay:(NSInteger)display;

/// The buffer for `display`, every rectangle moved by its origin. A display
/// nothing has secured reports an empty set rather than nil, so the SDK always
/// has a version to compare against.
- (NSData *)snapshotForDisplay:(NSInteger)display;

@end

NS_ASSUME_NONNULL_END
