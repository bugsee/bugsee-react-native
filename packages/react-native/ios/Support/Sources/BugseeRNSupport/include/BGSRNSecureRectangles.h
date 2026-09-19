#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

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

/// The buffer for `display`. A display nothing has secured reports an empty
/// set rather than nil, so the SDK always has a version to compare against.
- (NSData *)snapshotForDisplay:(NSInteger)display;

@end

NS_ASSUME_NONNULL_END
