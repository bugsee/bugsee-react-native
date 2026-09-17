import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    mirrorReactNativeLogToStandardError()

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "BareExample",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

/// Makes React Native's logs — including `console.log` from JS — visible to a
/// process attached to the app's stdout/stderr.
///
/// React Native 0.87's default log function writes to `os_log` and nothing
/// else, and os_log cannot be streamed off a physical iPhone from the command
/// line: macOS's `log stream` has no device flag, and
/// `devicectl device process launch --console` attaches to stdout/stderr.
/// Without this the e2e sees the app start and then nothing at all, which
/// looks exactly like the SDK failing to launch.
///
/// Debug only, and only in the example app. Nothing in the SDK depends on it.
private func mirrorReactNativeLogToStandardError() {
#if DEBUG
  let osLog = RCTDefaultLogFunction
  RCTSetLogFunction { level, source, fileName, lineNumber, message in
    osLog?(level, source, fileName, lineNumber, message)
    if let message, let data = (message + "\n").data(using: .utf8) {
      FileHandle.standardError.write(data)
    }
  }
#endif
}
