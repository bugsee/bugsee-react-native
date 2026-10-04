#import "BGSRNGuardedEmit.h"

#include <exception>
#include <typeinfo>

BOOL BGSRNGuardedEmit(dispatch_block_t emit, NSString *what) {
  if (emit == nil) {
    return NO;
  }
  // Everything is caught HERE, in Objective-C++, and never rethrown. The
  // callers are plain Objective-C compiled without -fobjc-arc-exceptions, so
  // an exception unwinding through one of their frames leaks every strong
  // local in it; a BOOL crosses back instead.
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
    // Not every C++ throw is a std::exception, and whatever this misses
    // unwinds to std::terminate.
    NSLog(@"[Bugsee] %@ could not be emitted: a non-std C++ exception", what);
    return NO;
  }
}
