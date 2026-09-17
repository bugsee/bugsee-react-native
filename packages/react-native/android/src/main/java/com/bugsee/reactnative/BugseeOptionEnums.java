package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.options.FrameRate;
import com.bugsee.library.contracts.options.IssueSeverity;
import com.bugsee.library.contracts.options.LogLevel;
import com.bugsee.library.contracts.options.VideoMode;
import com.bugsee.library.contracts.options.VideoQuality;

import java.io.Serializable;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Turns the numbers JS sends into the enum instances the Android SDK expects.
 *
 * <p>iOS consumes these numbers directly; Android's Map path does not coerce,
 * so an enum-typed option arriving as a number is ignored unless converted
 * here.
 *
 * <p><strong>The number is the enum's internal value, never its ordinal.</strong>
 * The two diverge on four of the five option enums — {@code LogLevel.Error} is
 * value 1 at ordinal 0, {@code VideoMode.Fullscreen} is value 20 at ordinal 3,
 * and {@code FrameRate} and {@code IssueSeverity} are likewise offset by one.
 * Only {@code VideoQuality} coincides. So conversion goes through each enum's
 * own {@code fromIntValue} / {@code fromRawValue} and never {@code values()[n]}:
 * an ordinal lookup returns a valid but DIFFERENT constant, which the SDK then
 * honours, and nothing reports it.
 *
 * <p>The internal values are also what iOS uses, so one number is correct on
 * both platforms — which is the whole reason the wrapper sends numbers.
 */
final class BugseeOptionEnums {

    /** Converts one number, or returns null when no constant carries it. */
    private interface Coercion {
        @Nullable
        Serializable apply(int value);
    }

    private static final Map<String, Coercion> BY_KEY = new HashMap<>();

    static {
        BY_KEY.put("com.bugsee.option.capture.logs.level",
                value -> LogLevel.fromRawValue((byte) value));
        BY_KEY.put("com.bugsee.option.capture.video.mode",
                VideoMode::fromIntValue);
        BY_KEY.put("com.bugsee.option.capture.video.quality",
                VideoQuality::fromIntValue);
        BY_KEY.put("com.bugsee.option.capture.video.frame-rate",
                FrameRate::fromIntValue);
        BY_KEY.put("com.bugsee.option.reporting.defaults.crash-priority",
                IssueSeverity::fromIntValue);
        BY_KEY.put("com.bugsee.option.reporting.defaults.error-priority",
                IssueSeverity::fromIntValue);
        BY_KEY.put("com.bugsee.option.reporting.defaults.bug-priority",
                IssueSeverity::fromIntValue);
    }

    private BugseeOptionEnums() {
    }

    /**
     * The enum constant for {@code value} under {@code key}, or null when the
     * key is not enum-typed or no constant carries that value.
     *
     * <p>Null for an unknown value is deliberate: the option is then absent
     * and the SDK applies its own default, which is the honest outcome for a
     * number the wrapper cannot interpret. Snapping to a nearby constant would
     * look like the option was honoured.
     */
    @Nullable
    static Serializable coerce(@NonNull final String key, final int value) {
        final Coercion coercion = BY_KEY.get(key);
        return coercion == null ? null : coercion.apply(value);
    }

    /**
     * What to store for a numeric option, or null to drop it.
     *
     * <p>JS has one number type, so every number arrives as a double. An
     * enum-typed key needs an exact integer: 20.5 names no constant, and
     * truncating it would silently pick one.
     */
    @Nullable
    static Serializable numberFor(@NonNull final String key, final double raw) {
        if (!isEnumKey(key)) {
            return raw;
        }
        if (Double.isNaN(raw) || Double.isInfinite(raw) || raw != Math.rint(raw)) {
            return null;
        }
        return coerce(key, (int) raw);
    }

    /** Whether this key carries an enum rather than a scalar. */
    static boolean isEnumKey(@NonNull final String key) {
        return BY_KEY.containsKey(key);
    }

    /** Every enum-typed key, so a test can assert the table is complete. */
    @NonNull
    static Set<String> enumKeys() {
        return Collections.unmodifiableSet(BY_KEY.keySet());
    }
}
