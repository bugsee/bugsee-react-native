#import "BGSRNGuardedEmit.h"

#include <exception>

void BGSRNGuardedEmit(dispatch_block_t emit, NSString *what) {
  if (emit == nil) {
    return;
  }
  try {
    emit();
  } catch (const std::exception &e) {
    [NSException raise:NSInternalInconsistencyException
                format:@"%@ could not be emitted: %s", what, e.what()];
  } catch (...) {
    // Not every C++ throw is a std::exception, and whatever this misses
    // unwinds to std::terminate.
    [NSException raise:NSInternalInconsistencyException
                format:@"%@ could not be emitted: a non-std C++ exception", what];
  }
}
