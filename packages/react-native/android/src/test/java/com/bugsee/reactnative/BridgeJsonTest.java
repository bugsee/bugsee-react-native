package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONException;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The Android half of the object transport: JSON text in, plain Java out.
 *
 * <p>Runs against the reference org.json (a {@code testImplementation}), not
 * Android's: the android.jar stubs have no bodies. The two differ in how they
 * box a fractional number, which is exactly why the parser normalises it --
 * these tests pin the normalised result, and the device run pins Android's.
 */
public class BridgeJsonTest {

    private static Map<String, Object> parse(final String json) throws Exception {
        return BridgeJson.parseObject(json);
    }

    private static void assertBad(final String json) {
        try {
            BridgeJson.parseObject(json);
            fail("expected BadJson for " + json);
        } catch (final BridgeJson.BadJson expected) {
            // The assertion is reaching here.
        }
    }

    /** The defect this transport exists for: a null member must survive, as a key. */
    @Test
    public void aTopLevelNullIsKeptAsAKeyWithANullValue() throws Exception {
        final Map<String, Object> map = parse("{\"nil\":null,\"s\":\"x\"}");
        assertTrue(map.containsKey("nil"));
        assertNull(map.get("nil"));
        assertEquals("x", map.get("s"));
        assertEquals(2, map.size());
    }

    @Test
    public void aNestedNullIsKeptInAnObjectAndInAnArray() throws Exception {
        final Map<String, Object> map = parse("{\"attributes\":{\"gone\":null},\"list\":[null,1]}");
        @SuppressWarnings("unchecked")
        final Map<String, Object> attributes = (Map<String, Object>) map.get("attributes");
        assertTrue(attributes.containsKey("gone"));
        assertNull(attributes.get("gone"));
        assertEquals(Arrays.asList(null, 1), map.get("list"));
    }

    /**
     * {@code JSONObject.NULL} must never escape: it is not {@code null}, and
     * the SDK would store or print it as the string "null".
     */
    @Test
    public void jsonNullIsJavaNullNotASentinel() throws Exception {
        final Object value = parse("{\"a\":null}").get("a");
        assertNull(value);
    }

    /** Integral: an Integer, or a Long past int range -- never a Double the SDK prints as 3.0. */
    @Test
    public void integralNumbersAreIntegers() throws Exception {
        final Map<String, Object> map = parse(
                "{\"int\":3,\"neg\":-7,\"zero\":0,\"big\":9007199254740991,\"minSafe\":-9007199254740992}");
        assertEquals(Integer.valueOf(3), map.get("int"));
        assertEquals(Integer.valueOf(-7), map.get("neg"));
        assertEquals(Integer.valueOf(0), map.get("zero"));
        assertEquals(Long.valueOf(9_007_199_254_740_991L), map.get("big"));
        assertEquals(Long.valueOf(-9_007_199_254_740_992L), map.get("minSafe"));
    }

    /** A fraction, and anything in exponent form, is a Double whatever org.json boxed it as. */
    @Test
    public void fractionalNumbersAreDoubles() throws Exception {
        final Map<String, Object> map = parse("{\"frac\":1.5,\"tiny\":1e-7,\"huge\":1e+300,\"neg\":-0.25}");
        assertEquals(Double.valueOf(1.5), map.get("frac"));
        assertEquals(Double.valueOf(1e-7), map.get("tiny"));
        assertEquals(Double.valueOf(1e300), map.get("huge"));
        assertEquals(Double.valueOf(-0.25), map.get("neg"));
    }

    /** Past Long range it cannot be an exact integer anyway: a Double, not a BigInteger. */
    @Test
    public void anIntegerPastLongRangeIsADouble() throws Exception {
        assertEquals(Double.valueOf(1e20), parse("{\"n\":100000000000000000000}").get("n"));
    }

    @Test
    public void booleansStayBooleans() throws Exception {
        final Map<String, Object> map = parse("{\"yes\":true,\"no\":false}");
        assertEquals(Boolean.TRUE, map.get("yes"));
        assertEquals(Boolean.FALSE, map.get("no"));
    }

    @Test
    public void nestedArraysAndObjectsBecomeListsAndMaps() throws Exception {
        final Map<String, Object> map = parse(
                "{\"nested\":{\"list\":[1,\"two\",{\"deep\":false},[true]],\"empty\":{}},\"none\":[]}");
        @SuppressWarnings("unchecked")
        final Map<String, Object> nested = (Map<String, Object>) map.get("nested");
        final List<Object> list = (List<Object>) nested.get("list");
        assertEquals(1, list.get(0));
        assertEquals("two", list.get(1));
        assertEquals(Collections.singletonMap("deep", (Object) false), list.get(2));
        assertEquals(Collections.singletonList(true), list.get(3));
        assertEquals(Collections.emptyMap(), nested.get("empty"));
        assertEquals(Collections.emptyList(), map.get("none"));
    }

    /** What JSON.stringify escapes must come back as the original string. */
    @Test
    public void stringsAreUnescaped() throws Exception {
        assertEquals("a\"b\\c\ndé", parse("{\"s\":\"a\\\"b\\\\c\\nd\\u00e9\"}").get("s"));
    }

    /** An ordinary key to both SDKs, as it is to the JS proxy. */
    @Test
    public void protoIsAnOrdinaryKey() throws Exception {
        assertEquals("x", parse("{\"__proto__\":\"x\"}").get("__proto__"));
    }

    @Test
    public void anEmptyObjectIsAnEmptyMap() throws Exception {
        assertEquals(Collections.emptyMap(), parse("{}"));
        assertEquals(Collections.emptyMap(), parse("  {}\n"));
    }

    @Test
    public void malformedJsonIsBad() {
        assertBad("{\"a\":");
        assertBad("{\"a\" 1}");
        assertBad("");
        assertBad("   ");
    }

    @Test
    public void anythingButAnObjectIsBad() {
        assertBad("[1,2]");
        assertBad("\"s\"");
        assertBad("3");
        assertBad("null");
        assertBad("true");
        assertBad("not json");
    }

    @Test
    public void trailingTextAfterTheObjectIsBad() {
        assertBad("{\"a\":1} x");
        assertBad("{\"a\":1}{}");
    }

    @Test
    public void aNullStringIsBad() {
        assertBad(null);
    }

    /**
     * Android's real libcore {@code JSONException} embeds the whole source
     * text in its message (unlike the reference org.json these tests
     * otherwise run against -- see the class doc), and that message reaches
     * logcat ({@code BugseeModule.event}) and a promise rejection
     * ({@code ReportOps.applyJson}) verbatim. Built by hand, shaped like a
     * real libcore message, since the only way to get the reference
     * implementation to embed the text this way is to fake it: this pins
     * {@link BridgeJson#malformedJsonMessage} itself, which is what actually
     * strips it, independent of which org.json parsed the text.
     */
    @Test
    public void malformedJsonMessageNeverIncludesTheInputText() {
        final String secret = "super-secret-value-should-not-leak";
        final String libcoreStyleInput = "{\"a\":\"" + secret;
        final JSONException libcoreStyle = new JSONException(
                "Unterminated string at character 15 of " + libcoreStyleInput);

        final String message = BridgeJson.malformedJsonMessage(
                libcoreStyle, libcoreStyleInput.length());

        assertFalse(message.contains(secret));
        assertFalse(message.contains(libcoreStyleInput));
        assertTrue(message.contains("15"));
        assertTrue(message.contains(String.valueOf(libcoreStyleInput.length())));
    }

    /** No usable position in the exception's own message: still no input text, just the length. */
    @Test
    public void malformedJsonMessageFallsBackToJustTheLengthWhenNoPositionIsReported() {
        final String secret = "another-secret-that-must-not-leak";
        final JSONException noPosition = new JSONException(secret);

        final String message = BridgeJson.malformedJsonMessage(noPosition, secret.length());

        assertFalse(message.contains(secret));
        assertTrue(message.contains(String.valueOf(secret.length())));
    }

    /**
     * End-to-end regression: with the reference org.json actually parsing
     * malformed text, the resulting {@link BridgeJson.BadJson} message still
     * never contains the input -- it just cannot pin the specific libcore leak
     * this class exists to close (see the two tests above for that).
     */
    @Test
    public void endToEndMalformedJsonNeverIncludesTheInputText() {
        final String secret = "super-secret-value-should-not-leak";
        final String json = "{\"a\":\"" + secret; // unterminated string
        try {
            BridgeJson.parseObject(json);
            fail("expected BadJson");
        } catch (final BridgeJson.BadJson e) {
            final String message = String.valueOf(e.getMessage());
            assertFalse(message.contains(secret));
            assertFalse(message.contains(json));
            assertTrue(message.contains(String.valueOf(json.length())));
        }
    }

    /** The trailing-text and non-object branches already avoid this; pinned so they stay that way. */
    @Test
    public void otherBadJsonMessagesAlsoNeverIncludeTheInputText() {
        final String withMarker = "{\"a\":1}<trailing-secret-marker>";
        try {
            BridgeJson.parseObject(withMarker);
            fail("expected BadJson");
        } catch (final BridgeJson.BadJson e) {
            assertFalse(String.valueOf(e.getMessage()).contains("trailing-secret-marker"));
        }
    }
}
