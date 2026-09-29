package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The custom-attribute rules, between the JS wire shape and the SDK's
 * {@code Bugsee.*} attribute surface. Plain Java, so every rule here is
 * unit-tested without React Native or a device.
 *
 * <p>Two facts about the SDK drive this class (design doc, Phase 5):
 * <ul>
 *   <li>Neither platform's {@code setAttribute} reports a dropped value
 *   truthfully, so a set is only trusted after a read-back confirms the SDK
 *   kept it ({@link #setAndVerify}).</li>
 *   <li>{@code Bugsee.getAttribute} (in-memory) and {@code Bugsee.getAllAttributes}
 *   (persisted, what the report is built from) can disagree: a fractional
 *   value is stored as a 32-bit float, so the persisted copy reads back
 *   widened, e.g. {@code 0.1} as {@code 0.10000000149011612} -- exactly what
 *   {@code manifest.json} carries. {@link #readable} and {@link #readOne}
 *   always read the persisted copy.</li>
 * </ul>
 */
final class AttributeBridge {

    private static final String TAG = "BugseeRN";

    /** The largest (and smallest, negated) integral double a {@code long} carries exactly. */
    static final long MAX_SAFE_LONG = 9_007_199_254_740_991L;

    /**
     * Class names {@link #readable} has already logged as unsupported, for
     * the life of the process. A read can run many times over that life --
     * once per {@code getAllAttributes} call -- so without this, mixed-in
     * native code that keeps writing a type this bridge does not know about
     * would re-log every such entry, on every read, forever.
     */
    private static final Set<String> LOGGED_UNSUPPORTED_TYPES = ConcurrentHashMap.newKeySet();

    /** What {@link #readable} calls to report a dropped, unsupported-type entry. */
    interface UnsupportedTypeLogger {
        void log(@NonNull String attributeName, @NonNull String className);
    }

    private static final UnsupportedTypeLogger DEFAULT_UNSUPPORTED_TYPE_LOGGER =
            (attributeName, className) -> Log.w(TAG, "attribute \"" + attributeName
                    + "\" has an unsupported type " + className
                    + "; dropped (logged once per type, per process)");

    private AttributeBridge() {
    }

    /** Test-only: clears the once-per-type guard {@link #readable} keeps for the process's life. */
    static void resetLoggedUnsupportedTypesForTest() {
        LOGGED_UNSUPPORTED_TYPES.clear();
    }

    /** What the module implements against; the production adapter calls {@code Bugsee.*}. */
    interface Sdk {
        void set(String name, Serializable value);

        /** {@code Bugsee.getAttribute}: the in-memory copy. */
        @Nullable
        Object getInMemory(String name);

        /** {@code Bugsee.getAllAttributes}: the persisted copy the report is built from. */
        @Nullable
        Map<String, Serializable> getPersisted();
    }

    /**
     * A JS number as the SDK should store it. An integral value within a
     * {@code long}'s exact double range crosses as {@link Long}; the SDK
     * would otherwise store a large integral value as a 32-bit float and
     * round it (the design doc's {@code 9007199254740991} example rounds up
     * to {@code ...992} as a {@code Double}). Anything else -- fractional, or
     * integral but too large -- crosses as {@link Double}.
     *
     * <p>{@code -0.0} is integral and within range, so it takes the same path
     * and becomes {@code Long} {@code 0}: a narrowing {@code double}-to-
     * {@code long} conversion has no signed zero to preserve.
     */
    @NonNull
    static Serializable numberValue(final double v) {
        if (!Double.isInfinite(v) && !Double.isNaN(v)
                && v == Math.rint(v) && Math.abs(v) <= MAX_SAFE_LONG) {
            return (long) v;
        }
        return v;
    }

    /**
     * Sets {@code value}, then reads it straight back through
     * {@link Sdk#getInMemory} and reports whether the SDK actually kept it.
     * Neither SDK's {@code setAttribute} reports a drop truthfully -- Android's
     * is {@code void}, and iOS returns {@code YES} even when it discards a
     * value for size -- so this read-back is the only honest signal.
     */
    static boolean setAndVerify(
            @NonNull final Sdk sdk,
            @NonNull final String name,
            @NonNull final Serializable value
    ) {
        sdk.set(name, value);
        return value.equals(sdk.getInMemory(name));
    }

    /**
     * The persisted attributes as JS can carry them: {@code string | number |
     * boolean | string[]}.
     *
     * <p>A {@link Float} -- what the SDK stores a large or fractional
     * {@code Double} as -- widens with {@code (double) floatValue()}, the same
     * widening the SDK's own JSON writer applies when it builds
     * {@code manifest.json}; any other {@link Number} (an {@link Integer} or
     * {@link Long} the SDK stored as given) widens with {@code doubleValue()},
     * which is exact for every value this bridge could have written through
     * {@link #numberValue}. A {@code Set<String>} becomes a {@link List} of its
     * string elements. Anything else has no JS representation and is
     * dropped, and its class name is reported through {@link
     * UnsupportedTypeLogger} once per type, for the life of the process
     * (see {@link #LOGGED_UNSUPPORTED_TYPES}) -- not once per read, since it
     * means the SDK is carrying a type this bridge does not know about, and
     * a read can happen many times.
     */
    @NonNull
    static Map<String, Object> readable(@Nullable final Map<String, Serializable> persisted) {
        return readable(persisted, DEFAULT_UNSUPPORTED_TYPE_LOGGER);
    }

    /** {@link #readable(Map)}, with the unsupported-type logger injectable for tests. */
    @NonNull
    static Map<String, Object> readable(
            @Nullable final Map<String, Serializable> persisted,
            @NonNull final UnsupportedTypeLogger logger
    ) {
        final Map<String, Object> result = new HashMap<>();
        if (persisted == null) {
            return result;
        }
        for (final Map.Entry<String, Serializable> entry : persisted.entrySet()) {
            final Object value = entry.getValue();
            if (value instanceof String || value instanceof Boolean) {
                result.put(entry.getKey(), value);
            } else if (value instanceof Float) {
                result.put(entry.getKey(), (double) ((Float) value).floatValue());
            } else if (value instanceof Number) {
                result.put(entry.getKey(), ((Number) value).doubleValue());
            } else if (value instanceof Set) {
                final List<String> list = new ArrayList<>();
                for (final Object element : (Set<?>) value) {
                    if (element instanceof String) {
                        list.add((String) element);
                    }
                }
                result.put(entry.getKey(), list);
            } else if (value != null) {
                final String className = value.getClass().getName();
                if (LOGGED_UNSUPPORTED_TYPES.add(className)) {
                    logger.log(entry.getKey(), className);
                }
            }
        }
        return result;
    }

    /**
     * One attribute, read from the persisted copy -- never {@link Sdk#getInMemory},
     * which can hold a value the persisted store would round differently. See
     * the class doc.
     */
    @Nullable
    static Object readOne(@NonNull final Sdk sdk, @NonNull final String name) {
        return readable(sdk.getPersisted()).get(name);
    }

    /**
     * The user identifier as JS should see it: {@code null} and {@code ""}
     * both read as absent. Android stores {@code ""} as given, and iOS's own
     * getter never returns it, so this is the one place both platforms agree
     * on "no identifier".
     */
    @Nullable
    static String identifier(@Nullable final String raw) {
        return raw == null || raw.isEmpty() ? null : raw;
    }
}
