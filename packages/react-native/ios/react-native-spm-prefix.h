// CocoaPods injects an implicit Foundation/UIKit import through a generated
// .pch. SPM has no equivalent, so this is force-included instead via
// -include in Package.swift's cSettings and cxxSettings. Without it, any
// source relying on those ambient imports fails to compile under SPM while
// still building fine under CocoaPods — a difference that only shows up on
// whichever delivery path you test second.
#ifdef __OBJC__
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#endif
