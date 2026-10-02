#import <Foundation/Foundation.h>

@class BugseeFeedbackModule;

NS_ASSUME_NONNULL_BEGIN

/// Calls into `BugseeFeedback` from Objective-C.
///
/// `BugseeFeedbackModule.mm` is Objective-C++ and is built with C++ modules
/// off, so it cannot import the Swift module. This client is the file that
/// can: `@import BugseeFeedback` for SPM, the pod's own generated header for
/// CocoaPods.
@interface BugseeFeedbackClient : NSObject
- (instancetype)initWithModule:(BugseeFeedbackModule *)module;
- (void)disarm;
- (void)showFeedbackUI;
- (void)setGreeting:(nullable NSString *)greeting;
- (void)setListenerEnabled:(BOOL)enabled;
@end

NS_ASSUME_NONNULL_END
