#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The app's own React root's surface key. Legacy writers that do not name a
/// surface land here.
FOUNDATION_EXPORT const NSInteger BGSRNSecureMainSurface;

/// The side of the square a surface whose origin is unknown serves before its
/// display's size is recorded (`setDisplaySize:forDisplay:`).
FOUNDATION_EXPORT const int32_t BGSRNSecureFallbackDisplaySize;

/// The regions the app has asked Bugsee not to record, in the form the SDK
/// pulls them.
///
/// The SDK does not subscribe to changes. It asks, 2-3 times a second and on
/// the MAIN thread, for a packed buffer of little-endian `int32`
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
/// Fabric `measureInWindow` is relative to the measured node's nearest
/// `RootNodeKind` ancestor: the app's root, or a `<Modal>`'s content (the
/// `ModalHostView` node, whose transform is the identity). Each rectangle is
/// stored under the surface it was measured in (the Modal host's React tag,
/// or `BGSRNSecureMainSurface`) and served moved by that surface's origin in
/// screen points. A Modal's origin is where its presented view controller's
/// view sits: the window's origin for a full-screen Modal, inset for a
/// `pageSheet` or `formSheet` one. A single origin for the display cannot
/// serve both.
///
/// Origins can be fractional. Left and top edges are moved and rounded down,
/// right and bottom ones up: a rectangle may grow by under a point, never
/// shrink. Edges saturate at the int32 range rather than wrap.
///
/// Fails closed: a surface whose origin has not been recorded yet, the main
/// one included, serves one rectangle covering its display (the screen's
/// bounds) instead of its rectangles.
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

/// Publishes `coordinates` as the secure set for `display`'s main surface.
///
/// @param coordinates may be NULL only when `count` is 0.
/// @param count number of int32s, which must be a multiple of 4.
/// @return NO, publishing nothing, when `count` is not whole rectangles.
- (BOOL)setCoordinates:(nullable const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display;

/// Publishes `coordinates` for one surface on `display`. Other surfaces keep
/// their rectangles and origins.
- (BOOL)setCoordinates:(nullable const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display
               surface:(NSInteger)surface;

/// Records where the main surface's window sits on `display`'s screen, in
/// points. Re-recording the same origin costs nothing.
- (void)setOrigin:(CGPoint)origin forDisplay:(NSInteger)display;

/// Records where one surface's `measureInWindow` (0, 0) sits on `display`'s
/// screen, in points. Only that surface's rectangles move.
- (void)setOrigin:(CGPoint)origin forDisplay:(NSInteger)display surface:(NSInteger)surface;

/// Records `display`'s screen size in points: what a surface whose origin is
/// unknown serves. Re-recording the same size costs nothing.
- (void)setDisplaySize:(CGSize)size forDisplay:(NSInteger)display;

/// The surfaces other than the main one that `display` has lanes for, in key
/// order: the ones whose origin the pull refreshes.
- (NSArray<NSNumber *> *)surfacesForDisplay:(NSInteger)display;

/// Forgets `surface` on every display where it holds no rectangles (its
/// Modal is gone). A surface that still holds rectangles stays.
- (void)dropSurfaceIfEmpty:(NSInteger)surface;

/// The buffer for `display`. A display nothing has secured reports an empty
/// set rather than nil, so the SDK always has a version to compare against.
- (NSData *)snapshotForDisplay:(NSInteger)display;

@end

NS_ASSUME_NONNULL_END
