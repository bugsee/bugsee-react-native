#import "BugseeFeedbackClient.h"

// SPM's generated header is the flat file BugseeFeedback-Swift.h next to
// BugseeFeedback.modulemap. This translation unit is Objective-C, so the
// clang module import finds it. The CocoaPods pod compiles the Swift
// sources itself, so the header is that target's own "Product-Swift.h".
// Exactly one delivery flag is set by the build.
#if BUGSEE_FEEDBACK_SPM
@import BugseeFeedback;
#elif BUGSEE_FEEDBACK_COCOAPODS
#import "BugseeReactNativeFeedback-Swift.h"
#else
#error "Bugsee feedback Swift header import is not configured"
#endif

/// The methods the relay calls. Declared here, not by importing the module
/// header: that header includes the codegen spec, which only compiles as
/// Objective-C++.
@interface BugseeFeedbackModule : NSObject
- (void)emitReceivedMessages:(NSString *)json;
- (void)emitSentMessage:(NSString *)message;
@end

/// Forwards `BugseeFeedbackListener` onto the TurboModule's events.
///
/// Held by the SDK weakly on iOS (`setListener:` stores a weak reference),
/// so this module keeps the strong reference. `module` is nilled in
/// `invalidate` before any emit, so a callback that already hopped to main
/// and is still queued drops the event instead of calling an unset emitter.
@interface BugseeFeedbackEventRelay : NSObject <BugseeFeedbackListener>
@property (nonatomic, weak) BugseeFeedbackModule *module;
@end

@implementation BugseeFeedbackEventRelay

- (void)onNewMessagesReceived:(NSArray<NSString *> *)messages {
  BugseeFeedbackModule *module = self.module;
  if (module == nil) {
    return;
  }
  NSString *json = @"[]";
  if ([messages isKindOfClass:[NSArray class]]) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:messages options:0 error:nil];
    if (data != nil) {
      json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"[]";
    }
  }
  [module emitReceivedMessages:json];
}

- (void)onNewMessageSent:(NSString *)message {
  BugseeFeedbackModule *module = self.module;
  if (module == nil || ![message isKindOfClass:[NSString class]]) {
    return;
  }
  [module emitSentMessage:message];
}

@end

/// The relay currently installed on `BugseeFeedback.shared`. The SDK holds
/// its listener weakly; this matches that. A reload installs the new
/// module's relay before the old `invalidate`, and only the owner may nil
/// the process-wide listener.
static __weak BugseeFeedbackEventRelay *InstalledFeedbackRelay = nil;

static void ClearInstalledFeedbackRelay(BugseeFeedbackEventRelay *relay) {
  if (InstalledFeedbackRelay != relay) {
    return;
  }
  InstalledFeedbackRelay = nil;
  [[BugseeFeedback shared] setListener:nil];
}

@implementation BugseeFeedbackClient {
  BugseeFeedbackEventRelay *_relay;
}

- (instancetype)initWithModule:(BugseeFeedbackModule *)module {
  if (self = [super init]) {
    // Idempotent. The SPM product also registers from +load; the CocoaPods
    // path compiles the Swift sources without that shim, so this is the
    // registration that path has.
    //
    // Do not install the listener here. The codegen std::function is unset
    // until getTurboModule runs, and an emit from init would throw
    // std::bad_function_call.
    [BugseeFeedback register];
    _relay = [BugseeFeedbackEventRelay new];
    _relay.module = module;
  }
  return self;
}

- (void)disarm {
  // Disarm this instance first. feedback-spm hops the callback to main; one
  // already queued reads module and drops the event once this is nil, even
  // when codegen has already cleared the emitter.
  _relay.module = nil;
  // Identity-checked, same shape as `if (BGSRNLogFilterModule == self)`.
  // A reload can install the new relay before this runs.
  ClearInstalledFeedbackRelay(_relay);
}

- (void)showFeedbackUI {
  [[BugseeFeedback shared] showFeedbackUI];
}

- (void)setGreeting:(NSString *)greeting {
  [[BugseeFeedback shared] setGreeting:greeting];
}

- (void)setListenerEnabled:(BOOL)enabled {
  if (!enabled) {
    ClearInstalledFeedbackRelay(_relay);
    return;
  }
  [[BugseeFeedback shared] setListener:_relay];
  InstalledFeedbackRelay = _relay;
}

@end
