#import <Foundation/Foundation.h>
#import <RNBugseeFeedbackSpec/RNBugseeFeedbackSpec.h>

NS_ASSUME_NONNULL_BEGIN

/// The iOS half of the `BugseeFeedbackModule` TurboModule.
///
/// Named so it does not collide with the SDK class `BugseeFeedback`. Inherits
/// the generated spec base because the spec declares event emitters, and
/// codegen puts `emitOnNewMessagesReceived:` on that base class.
@interface BugseeFeedbackModule : NativeBugseeFeedbackSpecBase <NativeBugseeFeedbackSpec>
@end

NS_ASSUME_NONNULL_END
