package com.bugsee.reactnative;

import android.util.Log;

import androidx.annotation.Nullable;

import com.bugsee.library.contracts.options.IssueSeverity;

import java.util.ArrayList;
import java.util.List;

/**
 * Turns the numbers and lists JS sends for a manual report into the types
 * the Android SDK expects.
 *
 * <p>Severity is the enum's internal value, never its ordinal.
 * {@code IssueSeverity.fromIntValue} maps anything outside 1..5 to
 * {@code VeryLow}, so the range is checked here first: {@code 0} and anything
 * else become null and the SDK applies its own default. Only a value outside
 * that sentinel is logged; {@code 0} is the wire's way of saying "default".
 */
final class ReportArgs {

    private static final String TAG = "BugseeRN";

    private ReportArgs() {
    }

    /** 0 and anything outside 1..5 are null (the SDK default). 1..5 map by value. */
    @Nullable
    static IssueSeverity severity(final int wire) {
        if (wire == 0) {
            return null;
        }
        if (wire >= 1 && wire <= 5) {
            return IssueSeverity.fromIntValue(wire);
        }
        Log.w(TAG, "severity " + wire + " is outside 1..5; the SDK default applies");
        return null;
    }

    /** null stays null. Anything that is not a string is dropped. */
    @Nullable
    static ArrayList<String> labels(@Nullable final List<?> wire) {
        if (wire == null) {
            return null;
        }
        final ArrayList<String> result = new ArrayList<>();
        for (final Object item : wire) {
            if (item instanceof String) {
                result.add((String) item);
            }
        }
        return result;
    }
}
