#import "BGSRNWrapperChannelHolder.h"

/**
 * By value, the table both platforms share: 1 Error .. 5 Verbose, and
 * anything else Info. Never `BugseeLogLevelInvalid` (0) -- a log line has no
 * honest reading of "invalid".
 */
static BugseeLogLevel BGSRNLogLevelForWireValue(NSInteger wire) {
  switch (wire) {
    case 1:
      return BugseeLogLevelError;
    case 2:
      return BugseeLogLevelWarning;
    case 3:
      return BugseeLogLevelInfo;
    case 4:
      return BugseeLogLevelDebug;
    case 5:
      return BugseeLogLevelVerbose;
    default:
      return BugseeLogLevelInfo;
  }
}

@implementation BGSRNWrapperChannelHolder

+ (instancetype)shared {
  static BGSRNWrapperChannelHolder *instance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    instance = [[BGSRNWrapperChannelHolder alloc] init];
  });
  return instance;
}

- (void)logMessage:(nullable NSString *)message level:(NSInteger)level {
  id<BGSWrapperChannel> current = self.channel;
  if (current == nil) {
    return;
  }
  // Every channel method is @optional -- a channel from an older-SDK-shaped
  // wrapper, or one built for tests, need not implement all of them.
  if (![current respondsToSelector:@selector(logWithTag:message:level:source:)]) {
    return;
  }
  // No @try here -- see the class comment in the header.
  [current logWithTag:nil
              message:message
                level:BGSRNLogLevelForWireValue(level)
               source:BGSLogEventSourceCustom];
}

- (void)addNetworkEvent:(nullable BugseeNetworkEvent *)event {
  id<BGSWrapperChannel> current = self.channel;
  if (current == nil) {
    return;
  }
  if (![current respondsToSelector:@selector(addNetworkEvent:requiresFiltering:)]) {
    return;
  }
  [current addNetworkEvent:event requiresFiltering:YES];
}

@end
