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
/// queue. The report object itself is unsynchronised and is only touched on
/// main; this lock guards the slot, not the report.
@interface BGSRNCreatedReports : NSObject

@property (class, readonly) BGSRNCreatedReports *shared;

/// 0 while a created report is outstanding or being created. Otherwise the
/// generation token `fulfil:reservation:` must present. A non-zero token is
/// an admission, which is what the existing tests assert. `clear` makes every
/// token issued so far fail that check: the SDK's completion is not cancelled.
- (NSUInteger)reserve;

/// Ends the reservation `reservation` names. A report gets `cr-<n>` (fresh for
/// this registry, never reused after a take) and holds the slot. nil frees the
/// slot and returns nil. A token that is not the current one — including every
/// token issued before `clear`, and the token of a reservation that has
/// already been fulfilled — returns nil and does not store a report or clear
/// the slot.
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

/// Drops the handle and a reservation the SDK has not fulfilled yet. An upload
/// already detached keeps the slot until `endUpload:` for its generation, so a
/// reload cannot construct another `BugseeExtendedReport` while that upload is
/// still copying attributes.
- (void)clear;

@end

NS_ASSUME_NONNULL_END
