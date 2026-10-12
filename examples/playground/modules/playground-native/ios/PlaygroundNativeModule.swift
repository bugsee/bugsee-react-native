import ExpoModulesCore
import os.log

public class PlaygroundNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PlaygroundNative")
    Function("crash") { (kind: String) in
      switch kind {
      case "segv": DispatchQueue.main.async { UnsafeMutablePointer<Int>(bitPattern: 0x8)!.pointee = 1 }
      case "abort": DispatchQueue.main.async { abort() }
      case "exception":
        DispatchQueue.main.async { NSException(name: .genericException, reason: "Playground native exception", userInfo: nil).raise() }
      default:
        Thread { NSException(name: .genericException, reason: "Playground background-thread exception", userInfo: nil).raise() }.start()
      }
    }
    Function("crashNdk") { (_: String) in }
    Function("hangMainThread") { (ms: Int) in DispatchQueue.main.async { Thread.sleep(forTimeInterval: Double(ms) / 1000) } }
    Function("log") { (level: String, message: String) in
      let type: OSLogType = level == "error" ? .error : level == "warn" ? .default : level == "debug" ? .debug : .info
      os_log("%{public}@", log: OSLog(subsystem: "com.bugsee.playground", category: "native"), type: type, message)
      NSLog("[playground %@] %@", level, message)
    }
    AsyncFunction("request") { (method: String, url: String, body: String?, promise: Promise) in
      guard let u = URL(string: url) else { promise.reject("E_URL", "bad url"); return }
      var req = URLRequest(url: u)
      req.httpMethod = method
      if let body = body { req.httpBody = body.data(using: .utf8); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
      URLSession.shared.dataTask(with: req) { data, resp, err in
        if let err = err { promise.reject("E_REQUEST", err.localizedDescription); return }
        promise.resolve(["status": (resp as? HTTPURLResponse)?.statusCode ?? 0, "body": String(data: data ?? Data(), encoding: .utf8) ?? ""])
      }.resume()
    }
    View(NativeSecureFieldView.self) {}
  }
}
