package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses the JSON text an object payload crosses the bridge as
 * ({@code encodeBridgeObject} in {@code src/bridge/json.ts}) into plain Java:
 * a {@code HashMap<String, Object>} ({@code HashMap} because that is what
 * {@code Bugsee.event} takes) of {@code null}, {@code Boolean},
 * {@code String}, {@code Integer}/{@code Long}/{@code Double}, nested maps and
 * {@code List}s. Key order is not part of the contract: the maps are
 * {@code LinkedHashMap}s, but the order they are filled in is whatever
 * {@code JSONObject.keys()} yields -- source order with Android's libcore
 * org.json, hash order with the reference org.json the JVM tests run -- and
 * nothing downstream depends on it.
 *
 * <p>Why JSON rather than a {@code ReadableMap}: iOS's TurboModule argument
 * conversion drops every {@code null} member of an object argument (React
 * Native's {@code convertJSIObjectToNSDictionary}, unless an app-level feature
 * flag says otherwise), so the same object argument meant different things on
 * the two platforms. One text transport, parsed natively on both, carries
 * {@code null} the same way everywhere.
 *
 * <p>Numbers are what org.json yields for an integral literal -- an
 * {@code Integer}, or a {@code Long} beyond int range -- so an integral JS
 * number reaches the SDK as an integer and its JSON writer prints {@code 3},
 * not {@code 3.0}. Anything else is a {@code Double}: normalised here rather
 * than passed through, because org.json implementations differ (Android's
 * yields {@code Double} for a fraction; the reference implementation the JVM
 * tests run against yields {@code BigDecimal}), and the SDK must see one type.
 */
final class BridgeJson {

    /** The text is not a JSON object; nothing was parsed. */
    static final class BadJson extends Exception {
        BadJson(@NonNull final String message) {
            super(message);
        }
    }

    private BridgeJson() {
    }

    /** What libcore's {@code JSONException} messages use to report where they gave up. */
    private static final Pattern CHARACTER_POSITION = Pattern.compile("character (\\d+)");

    /**
     * A message for a syntax error that never repeats the input text.
     *
     * <p>Android's libcore {@code JSONException} message embeds the ENTIRE
     * source text it was parsing (e.g. {@code "Unterminated string at
     * character 15 of {\"a\":\"bad}"}), and that message reaches logcat
     * ({@code BugseeModule.event}) and a promise rejection
     * ({@code ReportOps.applyJson}) verbatim. Neither is a safe place for
     * whatever the app happened to pass as event params or a report patch --
     * both a size concern and, for a params payload an app built from user
     * input, a potential information leak. This keeps only the position
     * libcore reports (when it reports one) and the input's length, and drops
     * the rest of the message, the exception's own text included.
     *
     * <p>Package-private, not {@code private}: {@code BridgeJsonTest} calls it
     * directly with a hand-built {@link JSONException} shaped like Android's
     * real libcore message (the reference org.json the JVM tests run against
     * never embeds the input text the way libcore does, so a real end-to-end
     * parse cannot exercise the leak this guards against).
     */
    @NonNull
    static String malformedJsonMessage(
            @NonNull final JSONException e, final int inputLength) {
        final Matcher matcher = CHARACTER_POSITION.matcher(String.valueOf(e.getMessage()));
        if (matcher.find()) {
            return "malformed JSON at character " + matcher.group(1)
                    + " of " + inputLength + " characters";
        }
        return "malformed JSON (" + inputLength + " characters)";
    }

    /**
     * The JSON object {@code json} holds, as plain Java.
     *
     * @throws BadJson when {@code json} is not exactly one JSON object -- a
     *     syntax error, another kind of value, or trailing text after it.
     *     Best effort: Android's libcore {@code JSONTokener} is lenient (it
     *     takes unquoted strings, single quotes, comments, {@code =>} and
     *     {@code ;} separators), so some text that is not strict JSON parses.
     *     The only producer is {@code JSON.stringify} in
     *     {@code encodeBridgeObject}, whose output is always strict JSON, so
     *     this rejects what can actually arrive malformed -- truncated text, a
     *     non-object, trailing text -- and does not pretend to be a validator.
     */
    @NonNull
    static HashMap<String, Object> parseObject(@Nullable final String json) throws BadJson {
        if (json == null) {
            throw new BadJson("expected a JSON object, got null");
        }
        final Object value;
        final JSONTokener tokener = new JSONTokener(json);
        try {
            value = tokener.nextValue();
            // org.json stops after the first value; anything but whitespace
            // after it means the text was not one object.
            if (tokener.nextClean() != 0) {
                throw new BadJson("trailing text after the JSON object");
            }
        } catch (final JSONException e) {
            throw new BadJson(malformedJsonMessage(e, json.length()));
        }
        if (!(value instanceof JSONObject)) {
            throw new BadJson("expected a JSON object");
        }
        return toMap((JSONObject) value);
    }

    @NonNull
    private static HashMap<String, Object> toMap(@NonNull final JSONObject object) {
        final HashMap<String, Object> result = new LinkedHashMap<>();
        final Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            final String key = keys.next();
            result.put(key, toJava(object.opt(key)));
        }
        return result;
    }

    @NonNull
    private static List<Object> toList(@NonNull final JSONArray array) {
        final List<Object> result = new ArrayList<>(array.length());
        for (int i = 0; i < array.length(); i++) {
            result.add(toJava(array.opt(i)));
        }
        return result;
    }

    @Nullable
    private static Object toJava(@Nullable final Object value) {
        if (value == null || value == JSONObject.NULL) {
            return null;
        }
        if (value instanceof JSONObject) {
            return toMap((JSONObject) value);
        }
        if (value instanceof JSONArray) {
            return toList((JSONArray) value);
        }
        if (value instanceof Integer || value instanceof Long) {
            return value;
        }
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        // String or Boolean: already the type the SDK takes.
        return value;
    }
}
