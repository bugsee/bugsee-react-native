#import "BugseeFeedbackModule.h"

#import <Bugsee/Bugsee.h>
#import <Bugsee/BugseeTheme.h>

// Header imports, not @import. This file is ObjC++, and neither delivery
// path enables C++ modules. SPM's product is the BugseeFeedback module; the
// CocoaPods path compiles the same Swift sources into this pod, whose
// generated header is named after the pod.
#if __has_include(<BugseeFeedback/BugseeFeedback-Swift.h>)
#import <BugseeFeedback/BugseeFeedback-Swift.h>
#elif __has_include(<BugseeReactNativeFeedback/BugseeReactNativeFeedback-Swift.h>)
#import <BugseeReactNativeFeedback/BugseeReactNativeFeedback-Swift.h>
#else
#import "BugseeReactNativeFeedback-Swift.h"
#endif

/// Forwards `BugseeFeedbackListener` onto the TurboModule's events.
///
/// Held by the SDK weakly on iOS (`setListener:` stores a weak reference),
/// so this module keeps the strong reference.
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
  [module emitOnNewMessagesReceived:@{@"messagesJson": json}];
}

- (void)onNewMessageSent:(NSString *)message {
  BugseeFeedbackModule *module = self.module;
  if (module == nil || ![message isKindOfClass:[NSString class]]) {
    return;
  }
  [module emitOnNewMessageSent:@{@"message": message}];
}

@end

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

- (instancetype)init {
  if (self = [super init]) {
    // Idempotent. The SPM product also registers from +load; the CocoaPods
    // path compiles the Swift sources without that shim, so this is the
    // registration that path has.
    [BugseeFeedback register];
    _relay = [BugseeFeedbackEventRelay new];
    _relay.module = self;
  }
  return self;
}

- (void)invalidate {
  _relay.module = nil;
  [[BugseeFeedback shared] setListener:nil];
}

- (void)showFeedbackUI {
  [[BugseeFeedback shared] showFeedbackUI];
}

- (void)setGreeting:(NSString *)greeting {
  [[BugseeFeedback shared] setGreeting:greeting];
}

- (void)setListenerEnabled:(BOOL)enabled {
  [[BugseeFeedback shared] setListener:enabled ? _relay : nil];
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
