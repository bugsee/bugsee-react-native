#import <Foundation/Foundation.h>
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, BGSRNNetworkEventOutcome) {
  BGSRNNetworkEventOutcomeAdded = 0,
  /// `eventWithID:` produced nothing. The caller logs the drop and returns.
  BGSRNNetworkEventOutcomeNoEvent,
  BGSRNNetworkEventOutcomeRejected,
};

typedef void (^BGSRNNetworkEventSubmit)(BugseeNetworkEvent *event, BOOL requiresFiltering);

/// Builds one app-recorded `BugseeNetworkEvent` and submits it with filtering
/// required. Shipped beta3's exchange-factory `createNetworkEvent` is a stub
/// that always returns nil, so this does not call it: the event is
/// `+[BugseeNetworkEvent eventWithID:HTTPmethod:...]`, then
/// `addNetworkEvent:requiresFiltering:` with YES. There is no timer that
/// would pass the original through.
///
/// `nowMs` is epoch milliseconds, the unit `BugseeGetCurrentTimeStampMs` uses.
FOUNDATION_EXPORT BGSRNNetworkEventOutcome BGSRNRecordNetworkEvent(
    NSDictionary<NSString *, id> *object,
    BGSRNNetworkEventSubmit submit,
    NSTimeInterval nowMs);

NS_ASSUME_NONNULL_END
