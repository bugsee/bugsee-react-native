package com.bugsee.e2enative;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.WindowManager;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.common.logging.FLog;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.common.ReactConstants;
import com.facebook.react.module.annotations.ReactModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The Android half of the example-only `BugseeE2E` TurboModule (Task 7.6a).
 *
 * <p>Never shipped: only examples/bare depends on the package. Calls run on
 * the native-modules thread. No message here echoes a caller's value.
 */
@ReactModule(name = BugseeE2EModule.NAME)
public class BugseeE2EModule extends NativeBugseeE2ESpec {

    public static final String NAME = "BugseeE2E";

    private static final String TAG = "BugseeE2E";

    /** The tag `nativeLog` lines carry (campaign N-12). */
    private static final String NATIVE_LOG_TAG = "BugseeE2ENative";

    static {
        System.loadLibrary("bugsee_e2e_native");
    }

    /** 0: SIGSEGV (a null store), 1: SIGABRT. Anything else returns. */
    private static native void nativeCrash(int kind);

    public BugseeE2EModule(final ReactApplicationContext context) {
        super(context);
    }

    @Override
    @NonNull
    public String getName() {
        return NAME;
    }

    @Override
    public void crashNative(final String kind) {
        if ("segv".equals(kind)) {
            nativeCrash(0);
        } else if ("abort".equals(kind)) {
            nativeCrash(1);
        } else {
            // JS rejects any other kind before it crosses; a void method must
            // not throw, so this only logs.
            Log.w(TAG, "crashNative: unknown kind ignored");
        }
    }

    @Override
    public void writeTempFile(final String name, final String contents, final Promise promise) {
        if (!TempFileNames.isPlain(name) || contents == null) {
            promise.reject("E_BAD_ARGUMENT", "writeTempFile: invalid name or contents");
            return;
        }
        try {
            final File file = new File(getReactApplicationContext().getCacheDir(), name);
            try (OutputStream out = new FileOutputStream(file, false)) {
                out.write(contents.getBytes(StandardCharsets.UTF_8));
            }
            promise.resolve(file.getAbsolutePath());
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "writeTempFile failed: " + e.getClass().getName());
            promise.reject("E_WRITE_FAILED", "writeTempFile: the file could not be written");
        }
    }

    @Override
    public void fileExists(final String path, final Promise promise) {
        try {
            promise.resolve(path != null && new File(path).isFile());
        } catch (RuntimeException e) {
            Log.w(TAG, "fileExists failed: " + e.getClass().getName());
            promise.reject("E_CHECK_FAILED", "fileExists: the path could not be checked");
        }
    }

    /**
     * Blocks the main thread for {@code ms} from a task posted to it, then
     * resolves (campaign N-12: hang detection). Logs when the block starts
     * and how long it really held the thread.
     */
    @Override
    public void blockMain(final double ms, final Promise promise) {
        final long millis = (long) ms;
        if (millis < 0 || millis > 60_000) {
            promise.reject("E_BAD_ARGUMENT", "blockMain: ms out of range");
            return;
        }
        new Handler(Looper.getMainLooper()).post(() -> {
            final long start = SystemClock.uptimeMillis();
            Log.i(TAG, "blockMain begin ms=" + millis);
            SystemClock.sleep(millis);
            Log.i(TAG, "blockMain end elapsed=" + (SystemClock.uptimeMillis() - start));
            promise.resolve(null);
        });
    }

    /** One line through android.util.Log, tag BugseeE2ENative. */
    @Override
    public void nativeLog(final String level, final String message) {
        if (message == null) {
            return;
        }
        switch (level == null ? "" : level) {
            case "debug":
                Log.d(NATIVE_LOG_TAG, message);
                break;
            case "info":
                Log.i(NATIVE_LOG_TAG, message);
                break;
            case "warn":
                Log.w(NATIVE_LOG_TAG, message);
                break;
            case "error":
                Log.e(NATIVE_LOG_TAG, message);
                break;
            default:
                Log.w(TAG, "nativeLog: unknown level ignored");
        }
    }

    /**
     * One line through React Native's own native logger (FLog, tag
     * ReactNative): the Android counterpart of an iOS RCTLog line, with no JS
     * echo.
     */
    @Override
    public void rctLog(final String level, final String message) {
        if (message == null) {
            return;
        }
        switch (level == null ? "" : level) {
            case "trace":
                FLog.v(ReactConstants.TAG, message);
                break;
            case "info":
                FLog.i(ReactConstants.TAG, message);
                break;
            case "warn":
                FLog.w(ReactConstants.TAG, message);
                break;
            case "error":
                FLog.e(ReactConstants.TAG, message);
                break;
            default:
                Log.w(TAG, "rctLog: unknown level ignored");
        }
    }

    /** Sets or clears FLAG_SECURE on the current activity's window, on the UI thread. */
    @Override
    public void setFlagSecure(final boolean on, final Promise promise) {
        UiThreadUtil.runOnUiThread(() -> {
            final Activity activity = getReactApplicationContext().getCurrentActivity();
            if (activity == null) {
                promise.reject("E_NO_ACTIVITY", "setFlagSecure: no current activity");
                return;
            }
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            final boolean set =
                (activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0;
            Log.i(TAG, "setFlagSecure on=" + on + " flag=" + set);
            promise.resolve(set == on);
        });
    }
}
