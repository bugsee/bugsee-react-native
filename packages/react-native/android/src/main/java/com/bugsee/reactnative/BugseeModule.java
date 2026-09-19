package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableMap;
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
public class BugseeModule extends NativeBugseeSpec implements WrapperEventBus.Sink {

    public static final String NAME = "Bugsee";

    public BugseeModule(final ReactApplicationContext context) {
        super(context);
        // Attached here, not on first subscribe: the SDK may emit before any JS
        // has run, and a listener that only exists once JS asks for it would
        // miss the launch transitions that a caller most wants.
        WrapperEventBus.shared().attach(this);
    }

    /**
     * Detaches from the event bus when the bridge goes away.
     *
     * <p>Identity-checked inside the bus: a reload can construct and attach the
     * NEW module before this one is invalidated, and an unconditional clear
     * would then silence the live bridge. Emitting into a dead module is the
     * classic React Native leak, so this is not optional.
     */
    @Override
    public void invalidate() {
        WrapperEventBus.shared().detach(this);
        super.invalidate();
    }

    @Override
    public void onLifecycleEvent(@NonNull final String name, @Nullable final String reportId) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("name", name);
        // Present only for the events that carry one, rather than null for the
        // rest: the JS type marks it optional, and a null would force every
        // caller to distinguish "absent" from "explicitly nothing".
        if (reportId != null) {
            payload.putString("reportId", reportId);
        }
        emitOnLifecycleEvent(payload);
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
    public void setWrapperInfo(final ReadableMap identity) {
        if (identity == null) {
            Bugsee.setWrapper(null);
            return;
        }
        final ReadableMap context = identity.hasKey("context")
                ? identity.getMap("context")
                : null;
        Bugsee.setWrapper(new BugseeReactNativeWrapper(
                string(identity, "type", "unknown"),
                string(identity, "version", "unknown"),
                identity.hasKey("build") ? identity.getString("build") : null,
                toStringMap(context)));
    }

    @Override
    public void setSecureRectangles(final double display, final ReadableArray coordinates) {
        // Codegen hands numbers across as double, because that is what a JS
        // number is. Rounding rather than truncating: the JS side has already
        // rounded each edge outwards, and truncating -0.9999 to 0 would pull an
        // edge back inside the region it was widened to cover.
        final int[] flat = new int[coordinates == null ? 0 : coordinates.size()];
        for (int i = 0; i < flat.length; i++) {
            flat[i] = (int) Math.round(coordinates.getDouble(i));
        }
        SecureRectangleStore.shared().set((int) display, flat);
    }

    private static String string(
            @NonNull final ReadableMap map,
            @NonNull final String key,
            @NonNull final String fallback
    ) {
        final String value = map.hasKey(key) ? map.getString(key) : null;
        return value == null ? fallback : value;
    }

    /**
     * The SDK types context as string-to-string. A non-string value would be
     * dropped rather than stringified: a number rendered as "1" is
     * indistinguishable from a version the wrapper actually reported.
     */
    private static Map<String, String> toStringMap(@Nullable final ReadableMap map) {
        final Map<String, String> result = new HashMap<>();
        if (map == null) {
            return result;
        }
        final ReadableMapKeySetIterator keys = map.keySetIterator();
        while (keys.hasNextKey()) {
            final String key = keys.nextKey();
            if (map.getType(key) == ReadableType.String) {
                result.put(key, map.getString(key));
            }
        }
        return result;
    }

    @Override
    public void getLaunchOptions(final Promise promise) {
        // Android's container is valid before launch too, in which case it
        // holds the SDK's own defaults -- so this answers a getter that the
        // app has not overridden, without the wrapper hardcoding anything.
        promise.resolve(toWritableMap(Bugsee.getLaunchOptions().toMap()));
    }

    @Override
    public void testCrash() {
        Bugsee.testCrash();
    }

    /** Turns the SDK's option map into something the bridge can return. */
    private static WritableMap toWritableMap(@Nullable final Map<String, Serializable> options) {
        final WritableMap result = Arguments.createMap();
        if (options == null) {
            return result;
        }
        for (final Map.Entry<String, Serializable> entry : options.entrySet()) {
            final Serializable value = entry.getValue();
            if (value instanceof Boolean) {
                result.putBoolean(entry.getKey(), (Boolean) value);
            } else if (value instanceof Number) {
                result.putDouble(entry.getKey(), ((Number) value).doubleValue());
            } else if (value instanceof String) {
                result.putString(entry.getKey(), (String) value);
            } else if (value instanceof Enum) {
                // Enums go back as the number they arrived as -- their
                // internal value, which is what both platforms speak.
                result.putDouble(entry.getKey(), BugseeOptionEnums.wireValue(value));
            }
            // Anything else has no JS representation; omitted rather than
            // stringified, which would read as a value the app could set back.
        }
        return result;
    }

    /**
     * Flattens the JS options map into what the SDK takes.
     *
     * <p>An unrecognised value is dropped rather than guessed at: a wrong
     * coercion would look like the option was honoured. Numbers go through
     * {@link BugseeOptionEnums}, because an enum-typed option arriving as a
     * bare number is ignored by the SDK's Map path.
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
                    // Enum-typed keys arrive as their internal value and must
                    // become enum instances: the SDK's Map path does not
                    // coerce, so a bare number is ignored. null means the
                    // value names no constant, and the option is dropped
                    // rather than guessed at.
                    final Serializable number =
                            BugseeOptionEnums.numberFor(key, options.getDouble(key));
                    if (number != null) {
                        result.put(key, number);
                    }
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
