package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.annotation.Nullable;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The plain-Java exception bridge: class-name contract, options shape, and
 * never-throwing send paths. No React Native, no device.
 */
public class ExceptionBridgeTest {

    private static final class RecordingSdk implements ExceptionBridge.Sdk {
        final List<Call> calls = new ArrayList<>();
        @Nullable RuntimeException throwOnNext;

        static final class Call {
            final String kind;
            final Throwable throwable;
            @Nullable final String domain;
            final int skipFrames;
            @Nullable final Map<String, Object> options;

            Call(
                    final String kind,
                    final Throwable throwable,
                    @Nullable final String domain,
                    final int skipFrames,
                    @Nullable final Map<String, Object> options
            ) {
                this.kind = kind;
                this.throwable = throwable;
                this.domain = domain;
                this.skipFrames = skipFrames;
                this.options = options;
            }
        }

        @Override
        public void logException(final Throwable t, @Nullable final String domain, final int skipFrames) {
            calls.add(new Call("handled", t, domain, skipFrames, null));
            if (throwOnNext != null) {
                final RuntimeException e = throwOnNext;
                throwOnNext = null;
                throw e;
            }
        }

        @Override
        public void logUnhandledException(final Throwable t, @Nullable final Map<String, Object> options) {
            calls.add(new Call("unhandled", t, null, 0, options));
            if (throwOnNext != null) {
                final RuntimeException e = throwOnNext;
                throwOnNext = null;
                throw e;
            }
        }
    }

    @Test
    public void theClassNameIsTheBackendContract() {
        assertEquals(
                "com.bugsee.reactnative.ReactNativeWebException",
                ReactNativeWebException.class.getName());
        assertTrue(ReactNativeWebException.class.getSimpleName().contains("ReactNativeWebException"));
    }

    @Test
    public void theReasonIsThePayloadVerbatim() {
        // Non-BMP (U+1F600 grinning face) plus surrounding whitespace that must
        // survive: the backend parses the reason as JSON after stripping a
        // class-name prefix, so a trimmed or re-encoded message would break it.
        final String payload = "  {\"m\":\"\uD83D\uDE00\"}  ";
        final ReactNativeWebException ex = new ReactNativeWebException(payload);
        assertEquals(payload, ex.getMessage());
    }

    @Test
    public void handledGoesToLogExceptionWithItsDomain() {
        final RecordingSdk sdk = new RecordingSdk();
        final String payload = "{\"name\":\"Error\",\"message\":\"x\"}";
        final String optionsJson = "{\"domain\":\"auth\",\"labels\":[\"a\",\"b\"]}";
        ExceptionBridge.logHandled(sdk, payload, optionsJson);
        assertEquals(1, sdk.calls.size());
        final RecordingSdk.Call call = sdk.calls.get(0);
        assertEquals("handled", call.kind);
        assertTrue(call.throwable instanceof ReactNativeWebException);
        assertEquals(payload, call.throwable.getMessage());
        assertEquals("auth", call.domain);
        assertEquals(0, call.skipFrames);
    }

    @Test
    public void unhandledGoesToLogUnhandledExceptionWithoutOptions() {
        final RecordingSdk sdk = new RecordingSdk();
        final String payload = "{\"name\":\"Error\",\"message\":\"fatal\"}";
        ExceptionBridge.logUnhandled(sdk, payload);
        assertEquals(1, sdk.calls.size());
        final RecordingSdk.Call call = sdk.calls.get(0);
        assertEquals("unhandled", call.kind);
        assertTrue(call.throwable instanceof ReactNativeWebException);
        assertEquals(payload, call.throwable.getMessage());
        assertNull(call.options);
    }

    @Test
    public void optionsCarryTheDomain() throws Exception {
        final ExceptionBridge.Options options = ExceptionBridge.options("{\"domain\":\"d\"}");
        assertNotNull(options);
        assertEquals("d", options.domain);
    }

    /** labels and includeVideo are not options any more: dropped like any other unknown key. */
    @Test
    public void unknownOptionKeysAreDropped() throws Exception {
        final ExceptionBridge.Options options = ExceptionBridge.options(
                "{\"domain\":\"d\",\"labels\":[1],\"skipFrames\":2,\"includeVideo\":1,\"extra\":true}");
        assertNotNull(options);
        assertEquals("d", options.domain);
    }

    @Test
    public void nullOptionsTextIsNullOptions() throws Exception {
        assertNull(ExceptionBridge.options(null));
    }

    @Test
    public void unparseableOptionsStillSendTheException() {
        final RecordingSdk sdk = new RecordingSdk();
        final String payload = "{\"name\":\"Error\",\"message\":\"still\"}";
        ExceptionBridge.logHandled(sdk, payload, "not-json");
        assertEquals(1, sdk.calls.size());
        final RecordingSdk.Call call = sdk.calls.get(0);
        assertEquals("handled", call.kind);
        assertEquals(payload, call.throwable.getMessage());
        assertNull(call.domain);
    }

    @Test
    public void aWronglyTypedDomainIsABadJson() {
        try {
            ExceptionBridge.options("{\"domain\":3}");
            fail("expected BadJson for a non-string domain");
        } catch (final BridgeJson.BadJson expected) {
            // Reached: a number is not a domain.
        }
    }

    @Test
    public void aThrowingSdkDoesNotEscape() {
        final RecordingSdk sdk = new RecordingSdk();
        sdk.throwOnNext = new RuntimeException("handled boom");
        ExceptionBridge.logHandled(sdk, "{}", null);
        assertEquals(1, sdk.calls.size());

        sdk.throwOnNext = new RuntimeException("unhandled boom");
        ExceptionBridge.logUnhandled(sdk, "{}");
        assertEquals(2, sdk.calls.size());
    }
}
