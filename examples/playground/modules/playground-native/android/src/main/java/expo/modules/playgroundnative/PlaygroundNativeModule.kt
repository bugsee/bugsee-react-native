package expo.modules.playgroundnative

import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlin.concurrent.thread

class PlaygroundNativeModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val client = OkHttpClient()

  // Each Function body ends in Unit: `when`/`post`/`thread` would otherwise make it return a Boolean or Thread,
  // which the bridge would try to convert for JS.
  override fun definition() = ModuleDefinition {
    Name("PlaygroundNative")
    Function("crash") { kind: String ->
      when (kind) {
        "segv" -> main.post { nativeCrash(0) }
        "abort" -> main.post { nativeCrash(1) }
        "exception" -> main.post { throw RuntimeException("Playground native exception") }
        else -> thread(name = "playground-bg") { throw IllegalStateException("Playground background-thread exception") }
      }
      Unit
    }
    Function("crashNdk") { kind: String ->
      main.post { nativeCrash(if (kind == "abort") 1 else 0) }
      Unit
    }
    Function("hangMainThread") { ms: Int ->
      main.post { Thread.sleep(ms.toLong()) }
      Unit
    }
    Function("log") { level: String, message: String ->
      val p = when (level) { "error" -> Log.ERROR; "warn" -> Log.WARN; "debug" -> Log.DEBUG; else -> Log.INFO }
      Log.println(p, "Playground", message)
      Unit
    }
    AsyncFunction("request") { method: String, url: String, body: String?, promise: Promise ->
      thread {
        try {
          val rb = body?.toRequestBody("application/json".toMediaType())
          client.newCall(Request.Builder().url(url).method(method, rb).build()).execute().use { r ->
            promise.resolve(mapOf("status" to r.code, "body" to (r.body?.string() ?: "")))
          }
        } catch (e: Exception) { promise.reject("E_REQUEST", e.message ?: "request failed", e) }
      }
    }
    View(NativeSecureFieldView::class) {}
  }

  private external fun nativeCrash(kind: Int)
  companion object { init { System.loadLibrary("playground_native") } }
}
