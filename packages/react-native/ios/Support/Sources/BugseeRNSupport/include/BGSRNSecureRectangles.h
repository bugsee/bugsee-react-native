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
/// bounds) instead of its rectangles. While no React root can be found at
/// all, the main surface stays that one rectangle: there is no origin to
/// record, and the store will not guess one (ruled, N8).
///
/// A Modal surface belongs to one JS runtime: its key is a React tag the next
/// runtime does not know. A reload drops every surface but the main one
/// (`claimRuntime`, `releaseRuntime:`), so a Modal that was open when the old
/// runtime went away does not mask the screen for the rest of the process. A
/// claim also empties the main surface's rectangles, keeping its origin: they
/// were the old runtime's, and its clearing write is ignored once stale
/// (below), so a new tree that never publishes on the main surface would
/// otherwise leave them masking until the process dies.
///
/// The claim also gates the module's rectangle writes
/// (`setCoordinates:count:forDisplay:surface:runtime:`): one whose claim is no
/// longer current is ignored, under the same lock as the claim. A reload can
/// start the new module before the old one is invalidated, and Fabric numbers
/// React tags from 1 again, so the old runtime's late writes would otherwise
/// put back a lane the claim dropped, or clear the new runtime's lane on the
/// same key and uncover its Modal. A Modal surface's host is named the same way
/// (`setHostResolver:forSurface:runtime:`), so the pull reads each origin
/// from the current runtime's host. Origins, display sizes and empty-lane drops are
/// written by the wrapper's pull, which belongs to no runtime.
///
/// ## Threading
///
/// Writes arrive on the JS thread; the pull is on the main thread. Every
/// published value is an immutable `NSData` swapped in whole. The SDK's header
/// is explicit that a buffer rewritten by another thread while it reads is a
/// use-after-free, so nothing here ever republishes into a buffer it has
/// already handed out.
/// A module's lookup of a surface's host by its React tag (see
/// `setHostResolver:forSurface:runtime:`).
typedef id _Nullable (^BGSRNSecureHostResolver)(NSInteger surface);

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
/// their rectangles and origins. Writes as whichever runtime holds the claim
/// now; a module uses the `runtime:` variant with its own claim.
- (BOOL)setCoordinates:(nullable const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display
               surface:(NSInteger)surface;

/// `setCoordinates:count:forDisplay:surface:`, written by the module holding
/// `claim` (from `claimRuntime`). What the TurboModule calls.
///
/// @return NO, publishing nothing, when `count` is not whole rectangles or a
/// newer runtime has claimed the store since `claim` was given.
- (BOOL)setCoordinates:(nullable const int32_t *)coordinates
                 count:(NSUInteger)count
            forDisplay:(NSInteger)display
               surface:(NSInteger)surface
               runtime:(NSInteger)claim;

/// The claim a runtime holds now. For writers that belong to no runtime of
/// their own (tests, single-runtime callers); a module writes with the claim
/// `claimRuntime` gave it.
- (NSInteger)currentClaim;

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

/// A new JS runtime's module is starting: drops every surface but the main
/// one, empties the main one's rectangles (keeping its origin), and returns
/// its claim. Serialised with `releaseRuntime:`, so an old
/// module released after the new one started cannot drop its surfaces.
- (NSInteger)claimRuntime;

/// The module holding `claim` is gone: drops every surface but the main one,
/// unless a newer runtime has already claimed the store.
- (void)releaseRuntime:(NSInteger)claim;

/// Records `host`, held weakly, as the view whose origin places `surface`, a
/// `<Modal>` lane of the module holding `claim`. The pull then reads the
/// origin from this host rather than searching the windows for a view with
/// the tag, which another runtime's host can share during a reload. Ignored
/// (NO) when the claim is stale, `surface` is the main one, or no display has
/// a lane for it. Every recorded host is forgotten on a claim and on a
/// release that drops lanes, and a surface's host goes with its last lane.
- (BOOL)setHost:(id)host forSurface:(NSInteger)surface runtime:(NSInteger)claim;

/// Records how the module holding `claim` finds `surface`'s host: a lookup
/// in its own runtime's view registry. A Modal's host is mounted after JS has
/// measured and published inside it, so the lookup is kept and asked (on
/// main, by `hostForSurface:accepting:`) until it finds the host, which is
/// then recorded as by `setHost:forSurface:runtime:`. Same rules: ignored
/// (NO) when the claim is stale, `surface` is the main one, or it has no
/// lane; forgotten with the surface's last lane and on a claim.
- (BOOL)setHostResolver:(BGSRNSecureHostResolver)resolver
             forSurface:(NSInteger)surface
                runtime:(NSInteger)claim;

/// `surface`'s host: the recorded one while it lives; otherwise what the
/// recorded lookup finds now, recorded if `accept` takes it and the claim it
/// was named with is still current. nil when there is neither, or the lookup
/// finds nothing acceptable. Calls the lookup outside the store's lock, on
/// the caller's thread: main, for a view registry.
- (nullable id)hostForSurface:(NSInteger)surface accepting:(BOOL (^)(id candidate))accept;

/// Whether the current runtime has named `surface`'s host or its lookup
/// (`setHost:...`, `setHostResolver:...`). Once it has, only that host places
/// the lane: a lookup that finds nothing yet means the origin is unknown, not
/// that the windows may be searched, where another runtime's host can be the
/// only one with the tag.
- (BOOL)isHostNamedForSurface:(NSInteger)surface;

/// Forgets `surface` on every display where it holds no rectangles (its
/// Modal is gone). A surface that still holds rectangles stays.
- (void)dropSurfaceIfEmpty:(NSInteger)surface;

/// The buffer for `display`. A display nothing has secured reports an empty
/// set rather than nil, so the SDK always has a version to compare against.
- (NSData *)snapshotForDisplay:(NSInteger)display;

@end

NS_ASSUME_NONNULL_END
