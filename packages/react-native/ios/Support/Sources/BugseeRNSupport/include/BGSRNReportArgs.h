#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// High (`BugseeSeverityHigh`, 3). Used when neither the requested severity
/// nor the launch option is an integer 1..5.
FOUNDATION_EXPORT const NSInteger BGSRNDefaultBugPriorityFallback;

/// `requested` when it is 1..5; otherwise
/// `launchOptions[BugseeOptionReportingDefaultBugPriority]` when that value
/// is an integer 1..5; otherwise `BGSRNDefaultBugPriorityFallback`.
FOUNDATION_EXPORT NSInteger BGSRNUploadSeverity(NSInteger requested, NSDictionary *_Nullable launchOptions);

/// nil for nil; the NSString elements otherwise. Anything else is dropped.
FOUNDATION_EXPORT NSArray<NSString *> *_Nullable BGSRNStringArray(NSArray *_Nullable raw);

NS_ASSUME_NONNULL_END
