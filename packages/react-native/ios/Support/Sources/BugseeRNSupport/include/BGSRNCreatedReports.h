#import <Foundation/Foundation.h>
// Not `@import Bugsee`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// One outstanding created report per process.
///
/// iOS beta3 keeps `BugseeExtendedReport` attributes in a file-scope global,
/// so a second created report wipes the first's (P5). The slot covers both
/// "the SDK is still making one" and "JS holds one", and `invalidate` clears
/// it because a reload's JS cannot know the handle.
///
/// `os_unfair_lock`: `createReport` can overlap an `invalidate` from another
/// queue. The caller reserves before any hop `invalidate` cannot cancel.
/// A reserve that ran after `clear` would hold the slot for a handle the
/// torn-down JS never uploads. The report object itself is unsynchronised
/// and is only touched on main; this lock guards the slot, not the report.
@interface BGSRNCreatedReports : NSObject

@property (class, readonly) BGSRNCreatedReports *shared;

/// 0 while a created report is outstanding or being created. Otherwise the
/// generation token `fulfil:reservation:` must present. A non-zero token is
/// an admission, which is what the existing tests assert. `clear` before
/// `beginCreate:` makes every token issued so far fail that check. The SDK's
/// completion is not cancelled.
- (NSUInteger)reserve;

/// YES when `reservation` is still the open one and `clear` has not run.
/// Does not take or free the slot.
- (BOOL)reservationIsOpen:(NSUInteger)reservation;

/// Marks `reservation` as having called `createReportWithCompletion:`.
/// NO when the token is not the open one, including after `clear`. The hop
/// uses this instead of a separate open check: `clear` between the two would
/// still `-init` a `BugseeExtendedReport`. Once this returns YES, `clear`
/// keeps the slot until `fulfil:reservation:` and that fulfil does not publish.
- (BOOL)beginCreate:(NSUInteger)reservation;

/// Ends the reservation `reservation` names. A report gets `cr-<n>` (fresh for
/// this registry, never reused after a take) and holds the slot. nil frees the
/// slot and returns nil. A token that is not the current one — including a
/// token `clear` dropped before `beginCreate:`, and the token of a reservation
/// that has already been fulfilled — returns nil and does not store a report
/// or clear the slot. After `beginCreate:`, `clear` leaves the token current
/// so this call can free the slot; it still does not publish a handle.
- (nullable NSString *)fulfil:(nullable BugseeExtendedReport *)report
                 reservation:(NSUInteger)reservation;

- (nullable BugseeExtendedReport *)reportFor:(NSString *)handleId;

/// Removes the report and frees the slot. nil when `handleId` is not the one held.
- (nullable BugseeExtendedReport *)take:(NSString *)handleId;

/// Drops the handle so later reads are dead, and keeps the slot until
/// `endUpload:` for `generationOut`. nil when `handleId` is not the one held;
/// `generationOut` is then 0. The slot stays taken because a second
/// `BugseeExtendedReport` resets the file-scope attributes beta3 shares.
- (nullable BugseeExtendedReport *)detachForUpload:(NSString *)handleId
                                        generation:(NSUInteger *)generationOut;

/// Frees the slot when `generation` is still the upload `detachForUpload:`
/// started. A later upload's generation does not match, so this does not free
/// that one. `clear` does not move the generation: the in-flight upload keeps
/// the slot until this runs.
- (void)endUpload:(NSUInteger)generation;

/// Drops the handle and a reservation `beginCreate:` has not started. An
/// upload already detached keeps the slot until `endUpload:` for its
/// generation, and a `createReportWithCompletion:` already started keeps the
/// slot until `fulfil:reservation:`. Either way a reload cannot `-init`
/// another `BugseeExtendedReport` while beta3 is still using the file-scope
/// attributes of the one in flight. The in-flight create's fulfil does not
/// publish a handle the torn-down JS cannot upload.
- (void)clear;

@end

NS_ASSUME_NONNULL_END
