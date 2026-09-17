#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// Wire numbers shared with the JS `Status` constants and with the Android
/// bridge's `BugseeStatusMapper`. They are API, not an implementation detail,
/// and are fixed here rather than derived from the enum so that an SDK
/// reordering its cases cannot silently change what JS sees.
typedef NS_ENUM(NSInteger, BGSRNStatusWire) {
  BGSRNStatusWireStopped = 0,
  BGSRNStatusWireLaunching = 1,
  BGSRNStatusWireLaunched = 2,
  BGSRNStatusWireStopping = 3,
};

/// Translates the SDK's status into the wire number.
///
/// An unrecognised value maps to `Stopped`: "we could not tell" is far closer
/// to stopped than launched, so a caller waiting to start keeps waiting rather
/// than proceeding on a state nobody mapped.
FOUNDATION_EXPORT NSInteger BGSRNStatusToWire(BugseeStatus status);

NS_ASSUME_NONNULL_END
