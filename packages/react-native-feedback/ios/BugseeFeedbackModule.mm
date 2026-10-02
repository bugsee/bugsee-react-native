#import "BugseeFeedbackModule.h"

#import <Bugsee/Bugsee.h>
#import <Bugsee/BugseeTheme.h>

#include <exception>

// Header import, not @import. This file is ObjC++, and neither delivery
// path enables C++ modules. A generated Swift header is not on disk when
// the preprocessor searches for it, so probing for the file selects a
// header this delivery does not produce.
//
// CocoaPods compiles the Swift sources into this pod, so the header is that
// target's own "Product-Swift.h" (BUGSEE_FEEDBACK_COCOAPODS). SPM consumes
// the BugseeFeedback product, so the header is that module's
// (BUGSEE_FEEDBACK_SPM). Exactly one of those is set by the build.
#if BUGSEE_FEEDBACK_SPM
#import <BugseeFeedback/BugseeFeedback-Swift.h>
#elif BUGSEE_FEEDBACK_COCOAPODS
#import "BugseeReactNativeFeedback-Swift.h"
#else
#error "Bugsee feedback Swift header import is not configured"
#endif

/// Same shape as `BGSRNGuardedEmit`. This target does not compile
/// BugseeRNSupport, so the catch lives here. The codegen `emitOn*` call is a
/// `std::function` that is unset until `getTurboModule` builds the JSI object,
/// and again after the module is invalidated. Calling an unset one throws
/// `std::bad_function_call`. Objective-C `@catch` cannot see a C++ exception,
/// so an unguarded emit unwinds to `std::terminate`. Caught here, and the
/// event is dropped.
static BOOL FeedbackGuardedEmit(dispatch_block_t emit, NSString *what) {
  if (emit == nil) {
    return NO;
  }
  try {
    @try {
      emit();
      return YES;
    } @catch (NSException *exception) {
      NSLog(@"[Bugsee] %@ could not be emitted: %@", what, exception);
      return NO;
    }
  } catch (const std::exception &e) {
    NSLog(@"[Bugsee] %@ could not be emitted: %s", what, e.what());
    return NO;
  } catch (...) {
    NSLog(@"[Bugsee] %@ could not be emitted: a non-std C++ exception", what);
    return NO;
  }
}

@interface BugseeFeedbackModule ()
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

static NSSet<NSString *> *FeedbackThemeKeys(void) {
  static NSSet<NSString *> *keys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // BugseeTheme.h in Bugsee 7.0.0-beta3. The SwiftUI chat in this beta
    // does not read them; they are still the appearance API the header
    // publishes, and the only one the feedback package can set.
    keys = [NSSet setWithArray:@[
      @"feedbackBarsColor",
      @"feedbackBackgroundColor",
      @"feedbackIncomingBubbleColor",
      @"feedbackOutgoingBubbleColor",
      @"feedbackIncomingTextColor",
      @"feedbackOutgoingTextColor",
      @"feedbackTitleTextColor",
      @"feedbackEmailSkipColor",
      @"feedbackEmailBackgroundColor",
      @"feedbackEmailContinueNotActiveColor",
      @"feedbackEmailContinueActiveColor",
      @"feedbackInputBackgroundColor",
      @"feedbackInputTextColor",
      @"feedbackCloseButtonColor",
      @"feedbackNavigationBarColor",
    ]];
  });
  return keys;
}

static BOOL ComponentOK(double value) {
  return value >= 0.0 && value <= 255.0 && value == value;
}

@implementation BugseeFeedbackModule {
  BugseeFeedbackEventRelay *_relay;
}

RCT_EXPORT_MODULE(BugseeFeedbackModule)

- (instancetype)init {
  if (self = [super init]) {
    // Idempotent. The SPM product also registers from +load; the CocoaPods
    // path compiles the Swift sources without that shim, so this is the
    // registration that path has.
    //
    // Do not install the listener or emit here. The codegen std::function
    // is unset until getTurboModule runs, and an emit from init would throw
    // std::bad_function_call.
    [BugseeFeedback register];
    _relay = [BugseeFeedbackEventRelay new];
    _relay.module = self;
  }
  return self;
}

- (void)invalidate {
  // Disarm this instance first. feedback-spm hops the callback to main; one
  // already queued reads module and drops the event once this is nil, even
  // when codegen has already cleared the emitter.
  _relay.module = nil;
  // Identity-checked, same shape as `if (BGSRNLogFilterModule == self)`.
  // A reload can install the new relay before this runs.
  ClearInstalledFeedbackRelay(_relay);
}

- (void)emitReceivedMessages:(NSString *)json {
  FeedbackGuardedEmit(^{
    [self emitOnNewMessagesReceived:@{@"messagesJson": json}];
  }, @"onNewMessagesReceived");
}

- (void)emitSentMessage:(NSString *)message {
  FeedbackGuardedEmit(^{
    [self emitOnNewMessageSent:@{@"message": message}];
  }, @"onNewMessageSent");
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

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  // Without this, RCTModuleProviders drops the class ("does not conform to
  // RCTModuleProvider") and the JS module never loads.
  return std::make_shared<facebook::react::NativeBugseeFeedbackSpecJSI>(params);
}

- (void)setAppearanceColor:(NSString *)name
                         r:(double)r
                         g:(double)g
                         b:(double)b
                         a:(double)a {
  if (![FeedbackThemeKeys() containsObject:name]) {
    return;
  }
  if (!ComponentOK(r) || !ComponentOK(g) || !ComponentOK(b) || !ComponentOK(a)) {
    return;
  }
  UIColor *color = [UIColor colorWithRed:(CGFloat)(r / 255.0)
                                    green:(CGFloat)(g / 255.0)
                                     blue:(CGFloat)(b / 255.0)
                                    alpha:(CGFloat)(a / 255.0)];
  [[BugseeTheme shared] setValue:color forKey:name];
}

@end
