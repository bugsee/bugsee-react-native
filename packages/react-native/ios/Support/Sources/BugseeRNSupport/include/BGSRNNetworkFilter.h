#import <Foundation/Foundation.h>
// Not `@import Bugsee;`: this header is included from ObjC++, where C++ modules
// are off on both delivery paths and a module import is a hard error.
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// The event, in the shape JS's filter receives. `type` matches the bundle:
/// `websocket` / `udpsocket` for sockets, otherwise the HTTP stage. The
/// websocket subtype is `websocketEvent`.
///
/// `body` is JSON null when the bytes are nil or empty. When they are
/// non-empty and not UTF-8 the key is omitted, so a spread of this snapshot
/// does not clear a JPEG, protobuf, or binary frame. Apply leaves a missing
/// key alone and treats JSON null as clear.
FOUNDATION_EXPORT NSString *_Nullable BGSRNNetworkEventJSON(BugseeNetworkEvent *event);

/// Writes `url`, `body` and `headers` from JS's replacement onto `event`.
/// A missing key is left alone. An illegal value, or a write that does not
/// stick, refuses the replacement so the caller drops the event.
FOUNDATION_EXPORT BOOL BGSRNApplyNetworkReplacement(BugseeNetworkEvent *event, NSString *_Nullable eventJson);

NS_ASSUME_NONNULL_END
