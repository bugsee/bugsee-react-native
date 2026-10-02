#import <Foundation/Foundation.h>
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, BGSRNNetworkEventOutcome) {
  BGSRNNetworkEventOutcomeAdded = 0,
  /// The factory was missing or `createNetworkEvent` returned nil.
  BGSRNNetworkEventOutcomeNoEvent,
  BGSRNNetworkEventOutcomeRejected,
};

typedef id _Nullable (^BGSRNNetworkEventCreate)(NSTimeInterval timestamp,
                                                BGSNetworkEventStage stage,
                                                NSString *_Nullable eventId,
                                                NSString *_Nullable mechanism,
                                                NSString *_Nullable method);

typedef void (^BGSRNNetworkEventSubmit)(id event, BOOL requiresFiltering);

/// Builds one app-recorded network event and submits it with filtering
/// required. `create` nil, or a nil event, is {@link BGSRNNetworkEventOutcomeNoEvent}.
/// The caller logs `addNetworkEvent dropped: the SDK made no event` for that
/// and does not pass the original through on a timer.
///
/// `now` is milliseconds, the unit the exchange factory stamps.
FOUNDATION_EXPORT BGSRNNetworkEventOutcome BGSRNRecordNetworkEvent(
    NSDictionary<NSString *, id> *object,
    BGSRNNetworkEventCreate _Nullable create,
    BGSRNNetworkEventSubmit submit,
    NSTimeInterval nowMs);

NS_ASSUME_NONNULL_END
