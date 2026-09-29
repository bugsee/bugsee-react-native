package com.bugsee.e2enative;

import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.annotations.ReactModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

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

    /** The JS rule, again: a plain name cannot leave the cache directory. */
    private static final Pattern FILE_NAME = Pattern.compile("^[\\w.-]{1,64}$");

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
        if (name == null || !FILE_NAME.matcher(name).matches() || name.matches("^\\.+$")
                || contents == null) {
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
}
