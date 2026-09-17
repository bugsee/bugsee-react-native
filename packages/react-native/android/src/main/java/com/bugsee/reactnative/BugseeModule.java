package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.module.annotations.ReactModule;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

/**
 * The Android half of the `Bugsee` TurboModule.
 *
 * <p>Thin on purpose. Everything that translates between the JS wire shape and
 * the SDK's types lives in {@link BugseeTokens} and {@link BugseeStatusMapper},
 * which are plain Java and unit-tested without React Native or a device; what
 * is left here is the part that can only be exercised by running the app, and
 * is covered by the example app's e2e instead.
 */
@ReactModule(name = BugseeModule.NAME)
public class BugseeModule extends NativeBugseeSpec {

    public static final String NAME = "Bugsee";

    public BugseeModule(final ReactApplicationContext context) {
        super(context);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    @Override
    public void launch(final String token, final ReadableMap options, final Promise promise) {
        if (!BugseeTokens.isUsable(token)) {
            promise.reject("E_TOKEN", "Bugsee.launch requires a non-empty app token");
            return;
        }
        // The Application, not the React context: the SDK registers activity
        // lifecycle callbacks on it and outlives any single React instance.
        Bugsee.launch(
                getReactApplicationContext().getApplicationContext(),
                token,
                toOptions(options),
                // The SDK reports whether it actually started. Declining — it
                // is already running, or the token was rejected — is a normal
                // outcome, so it resolves false rather than rejecting.
                launched -> promise.resolve(Boolean.TRUE.equals(launched)));
    }

    @Override
    public void relaunch(final ReadableMap options, final Promise promise) {
        Bugsee.relaunch(toOptions(options), relaunched -> promise.resolve(Boolean.TRUE.equals(relaunched)));
    }

    @Override
    public void stop(final Promise promise) {
        Bugsee.stop(() -> promise.resolve(true));
    }

    @Override
    public void getStatus(final Promise promise) {
        promise.resolve(BugseeStatusMapper.toWire(Bugsee.getStatus()));
    }

    @Override
    public void testCrash() {
        Bugsee.testCrash();
    }

    /**
     * Flattens the JS options map into what the SDK takes.
     *
     * <p>Only the scalar types Phase 1 needs. The typed options model, the
     * `com.bugsee.option.*` keys and the number→enum coercion each option
     * needs arrive in Phase 2; until then an unrecognised value is dropped
     * rather than guessed at, because a wrong coercion would look like the
     * option was honoured.
     */
    private static Map<String, Serializable> toOptions(@Nullable final ReadableMap options) {
        final Map<String, Serializable> result = new HashMap<>();
        if (options == null) {
            return result;
        }
        final ReadableMapKeySetIterator keys = options.keySetIterator();
        while (keys.hasNextKey()) {
            final String key = keys.nextKey();
            switch (options.getType(key)) {
                case Boolean:
                    result.put(key, options.getBoolean(key));
                    break;
                case Number:
                    result.put(key, options.getDouble(key));
                    break;
                case String:
                    result.put(key, options.getString(key));
                    break;
                default:
                    break;
            }
        }
        return result;
    }
}
