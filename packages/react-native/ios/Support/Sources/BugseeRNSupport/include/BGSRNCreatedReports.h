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

/// NO while a created report is outstanding or being created.
- (BOOL)reserve;

/// Ends a reservation. A report gets `cr-<n>` (fresh for this registry, never
/// reused after a take) and holds the slot. nil frees the slot and returns nil.
- (nullable NSString *)fulfil:(nullable BugseeExtendedReport *)report;

- (nullable BugseeExtendedReport *)reportFor:(NSString *)handleId;

/// Removes the report and frees the slot. nil when `handleId` is not the one held.
- (nullable BugseeExtendedReport *)take:(NSString *)handleId;

/// Drops the handle and frees the slot, including a reservation the SDK has
/// not fulfilled yet.
- (void)clear;

@end

NS_ASSUME_NONNULL_END
