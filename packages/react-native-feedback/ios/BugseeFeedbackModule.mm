#import "BugseeFeedbackModule.h"

#import "BugseeFeedbackClient.h"

#import <Bugsee/Bugsee.h>
#import <Bugsee/BugseeTheme.h>

#include <exception>
#include <typeinfo>

// BugseeFeedback itself is imported by BugseeFeedbackClient.m. This file is
// Objective-C++ with C++ modules off, so it cannot import that Swift module,
// and the generated header is not on this target's header search path.

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
      NSLog(@"[Bugsee] %@ could not be emitted: %@", what, NSStringFromClass(exception.class));
      return NO;
    }
  } catch (const std::exception &e) {
    // The type only: what() is the exception's own message.
    NSLog(@"[Bugsee] %@ could not be emitted: %s", what, typeid(e).name());
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

static NSSet<NSString *> *FeedbackThemeKeys(void) {
  static NSSet<NSString *> *keys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // BugseeTheme.h in Bugsee 7.0.0-beta4 (unchanged from beta3). The SwiftUI chat in this beta
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
  BugseeFeedbackClient *_client;
}

RCT_EXPORT_MODULE(BugseeFeedbackModule)

- (instancetype)init {
  if (self = [super init]) {
    // Do not install the listener or emit here. The codegen std::function
    // is unset until getTurboModule runs, and an emit from init would throw
    // std::bad_function_call. Registration and the relay live on the client.
    _client = [[BugseeFeedbackClient alloc] initWithModule:self];
  }
  return self;
}

- (void)invalidate {
  [_client disarm];
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
  [_client showFeedbackUI];
}

- (void)setGreeting:(NSString *)greeting {
  [_client setGreeting:greeting];
}

- (void)setListenerEnabled:(BOOL)enabled {
  [_client setListenerEnabled:enabled];
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
