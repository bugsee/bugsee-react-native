import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  /// The scene's window, kept here too for code that still reads
  /// `UIApplication.shared.delegate?.window`.
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  /// React Native starts in the window `SceneDelegate` creates: since iOS 27
  /// an app that has not adopted the UIScene lifecycle is stopped at launch
  /// (`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`), and
  /// `Info.plist` declares the one scene this app has.
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

    return true
  }
}

/// Creates the app's one window and starts React Native in it.
///
/// It forwards no URLs to React Native: neither `connectionOptions.urlContexts`
/// at launch nor `scene(_:openURLContexts:)` later, so `Linking` sees none on
/// iOS. This app registers no URL scheme; the e2e steers its iOS launches
/// through launch arguments (`e2e/scenario.ts`). An app that opens URLs hands
/// both to `RCTLinkingManager`.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "BareExample",
      in: window,
      launchOptions: nil
    )
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
/// Debug mirrors every React Native log to stderr. Release only `NSLog`s
/// lines that contain `BUGSEE_E2E`: a Release build does not compile the
/// stderr mirror, and `console.log` otherwise stays in `os_log`, which
/// `devicectl` console cannot stream. The native `BugseeRN` lines are already
/// `NSLog`.
private func mirrorReactNativeLogToStandardError() {
  let osLog = RCTDefaultLogFunction
  RCTSetLogFunction { level, source, fileName, lineNumber, message in
    osLog?(level, source, fileName, lineNumber, message)
    guard let message else { return }
    if message.contains("BUGSEE_E2E") {
      NSLog("%@", message)
    }
#if DEBUG
    if let data = (message + "\n").data(using: .utf8) {
      FileHandle.standardError.write(data)
    }
#endif
  }
}
