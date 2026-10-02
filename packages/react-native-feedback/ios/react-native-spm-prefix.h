// CocoaPods injects an implicit Foundation/UIKit import through a generated
// .pch. SPM has no equivalent, so this is force-included instead. Same
// requirement as the core package's prefix header.
#ifdef __OBJC__
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#endif
