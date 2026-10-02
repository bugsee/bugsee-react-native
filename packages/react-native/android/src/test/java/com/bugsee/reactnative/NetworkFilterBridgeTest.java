package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.NetworkEvent;
import com.bugsee.library.contracts.options.Options;
import com.bugsee.library.contracts.options.OptionsContainer;

import org.json.JSONObject;
import org.junit.Test;

import java.lang.reflect.Proxy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A reply that arrives after bugsee-android has recycled the pooled network
 * entry must not write the URL or call {@code callback.run}. The SDK has
 * already dropped the event; touching the entry writes onto whatever event
 * owns it now.
 */
public class NetworkFilterBridgeTest {

    /** Runs a task only when the test says so. */
    private static final class ManualScheduler implements NetworkFilterBridge.Scheduler {
        static final class Task implements NetworkFilterBridge.Cancellable {
            final Runnable runnable;
            final long delayMs;
            boolean cancelled;

            Task(final Runnable runnable, final long delayMs) {
                this.runnable = runnable;
                this.delayMs = delayMs;
            }

            @Override
            public void cancel() {
                cancelled = true;
            }

            void run() {
                if (!cancelled) {
                    runnable.run();
                }
            }
        }

        final List<Task> tasks = new ArrayList<>();

        @Override
        @NonNull
        public NetworkFilterBridge.Cancellable schedule(@NonNull final Runnable task, final long delayMs) {
            final Task handle = new Task(task, delayMs);
            tasks.add(handle);
            return handle;
        }

        void fire() {
            for (final Task task : tasks) {
                task.run();
            }
        }
    }

    private static final class RecordingCallback implements Callback1<NetworkEvent> {
        int runs;
        @Nullable NetworkEvent last;
        boolean sawNull;

        @Override
        public void run(@Nullable final NetworkEvent value) {
            runs += 1;
            last = value;
            if (value == null) {
                sawNull = true;
            }
        }
    }

    private static final class RecordingSink implements NetworkFilterBridge.Sink {
        final List<String> ids = new ArrayList<>();
        final List<String> json = new ArrayList<>();

        @Override
        public void onNetworkFilterRequest(@NonNull final String requestId, @NonNull final String eventJson) {
            ids.add(requestId);
            json.add(eventJson);
        }
    }

    /** The fields the bridge reads to recognise a recycled pooled entry. */
    private static final class MutableNetwork implements NetworkEvent {
        @Nullable String id;
        @Nullable String url;
        @Nullable String body;
        @Nullable String errorDescription;
        @Nullable String errorShortMessage;
        @Nullable String statusText;
        int setUrlCalls;

        MutableNetwork(@NonNull final String url) {
            this.id = "id-1";
            this.url = url;
        }

        @Override
        public long getTimestamp() {
            return 1L;
        }

        @Override
        public String getId() {
            return id;
        }

        @Override
        public String getMechanism() {
            return "URLConnection";
        }

        @Override
        public String getUrl() {
            return url;
        }

        @Override
        public void setUrl(@Nullable final String url) {
            setUrlCalls += 1;
            this.url = url;
        }

        @Override
        public String getBody() {
            return body;
        }

        @Override
        public void setBody(@Nullable final String body) {
            this.body = body;
        }

        @Override
        public long getSize() {
            return 0L;
        }

        @Override
        public String getErrorShortMessage() {
            return errorShortMessage;
        }

        @Override
        public void setErrorShortMessage(@Nullable final String message) {
            errorShortMessage = message;
        }

        @Override
        public String getErrorDescription() {
            return errorDescription;
        }

        @Override
        public void setErrorDescription(@Nullable final String description) {
            errorDescription = description;
        }

        @Override
        public Map<String, String> getHeaders() {
            return null;
        }

        @Override
        public String getMethod() {
            return "GET";
        }

        @Override
        public NetworkBodyAbsenceReason getBodyAbsenceReason() {
            return null;
        }

        @Override
        public int getResponseCode() {
            return 0;
        }

        @Override
        public void setResponseCode(final int code) {
        }

        @Override
        public String getStatusText() {
            return statusText;
        }

        @Override
        public void setStatusText(@Nullable final String text) {
            statusText = text;
        }

        @Override
        public NetworkEventStage getNetworkEventType() {
            return NetworkEventStage.RequestStarted;
        }

        @Override
        public WebSocketEventType getWebSocketEventType() {
            return null;
        }
    }

    private final ManualScheduler scheduler = new ManualScheduler();
    /** The borrow tests leave the default sanitizer off. It needs no launched SDK. */
    private final NetworkFilterBridge bridge = new NetworkFilterBridge(scheduler, () -> false);

    @Test
    public void aReplyAfterTheUrlChangedDoesNotTouchTheEntry() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableNetwork event = new MutableNetwork("https://secret.example/token");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);
        final String id = sink.ids.get(0);

        event.url = "https://other.example/now";
        bridge.reply(id, "{\"url\":\"https://redacted.example/path\"}");

        assertEquals(0, event.setUrlCalls);
        assertEquals("https://other.example/now", event.url);
        assertEquals(0, callback.runs);
        assertEquals(NetworkFilterBridge.BORROW_MS, scheduler.tasks.get(0).delayMs);
        assertTrue(NetworkFilterBridge.BORROW_MS < 10_000L);
    }

    @Test
    public void aDeadlineForgetsThePendingWithoutCallingTheCallback() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableNetwork event = new MutableNetwork("https://secret.example/token");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        scheduler.fire();
        bridge.reply(sink.ids.get(0), "{\"url\":\"https://redacted.example/path\"}");

        assertEquals(0, callback.runs);
        assertEquals(0, event.setUrlCalls);
        assertEquals("https://secret.example/token", event.url);
    }

    @Test
    public void aReplyWhileTheEntryIsStillTheOriginalWritesItBack() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableNetwork event = new MutableNetwork("https://secret.example/token");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        bridge.reply(sink.ids.get(0), "{\"url\":\"https://redacted.example/path\"}");

        assertEquals(1, event.setUrlCalls);
        assertEquals("https://redacted.example/path", event.url);
        assertEquals(1, callback.runs);
        assertSame(event, callback.last);
        assertTrue(scheduler.tasks.get(0).cancelled);
    }

    @Test
    public void aNullReplyDropsALiveBorrow() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableNetwork event = new MutableNetwork("https://secret.example/token");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        bridge.reply(sink.ids.get(0), null);

        assertEquals(1, callback.runs);
        assertTrue(callback.sawNull);
        assertNull(callback.last);
        assertEquals(0, event.setUrlCalls);
    }

    @Test
    public void detachDropsALiveBorrowAndSkipsARecycledOne() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableNetwork live = new MutableNetwork("https://live.example");
        final RecordingCallback liveCallback = new RecordingCallback();
        bridge.ask(live, liveCallback);
        final MutableNetwork recycled = new MutableNetwork("https://secret.example");
        final RecordingCallback recycledCallback = new RecordingCallback();
        bridge.ask(recycled, recycledCallback);
        recycled.url = null;

        bridge.detach(sink);

        assertEquals(1, liveCallback.runs);
        assertTrue(liveCallback.sawNull);
        assertEquals(0, recycledCallback.runs);
        assertEquals(0, recycled.setUrlCalls);
    }

    /**
     * The real 7.3.0 sanitizer redacts a {@code token} query. That happens
     * before the url is remembered, so a reply still matches {@code stillBorrowed}
     * and the error fields in the snapshot are written back.
     */
    @Test
    public void aDefaultSanitizerRedactsTokenBeforeTheUrlIsRemembered() throws Exception {
        final ManualScheduler localScheduler = new ManualScheduler();
        final NetworkFilterBridge sanitizing = new NetworkFilterBridge(localScheduler, () -> true);
        final RecordingSink sink = new RecordingSink();
        sanitizing.attach(sink);
        final MutableNetwork event = new MutableNetwork(
                "https://api.example/v1/items?token=bugsee-secret-token-value&ok=1"
        );
        final RecordingCallback callback = new RecordingCallback();
        sanitizing.ask(event, callback);

        final String json = sink.json.get(0);
        assertFalse(json.contains("bugsee-secret-token-value"));
        assertTrue(json.contains("token=%3Credacted%3E"));
        assertTrue(event.url.contains("token=%3Credacted%3E"));
        final JSONObject snapshot = new JSONObject(json);
        assertTrue(snapshot.isNull("errorDescription"));
        assertTrue(snapshot.isNull("errorShortMessage"));
        assertTrue(snapshot.isNull("statusText"));

        snapshot.put("errorDescription", "gateway");
        snapshot.put("errorShortMessage", "late");
        snapshot.put("statusText", "OK");
        sanitizing.reply(sink.ids.get(0), snapshot.toString());

        assertEquals(1, callback.runs);
        assertSame(event, callback.last);
        assertEquals("gateway", event.errorDescription);
        assertEquals("late", event.errorShortMessage);
        assertEquals("OK", event.statusText);
        assertTrue(event.url.contains("token=%3Credacted%3E"));
        assertFalse(event.url.contains("bugsee-secret-token-value"));
    }

    @Test
    public void jsonNullClearsErrorFieldsAndStatusText() throws Exception {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableNetwork event = new MutableNetwork("https://api.example/v1/items");
        event.errorDescription = "gateway";
        event.errorShortMessage = "late";
        event.statusText = "OK";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        final JSONObject snapshot = new JSONObject(sink.json.get(0));
        assertEquals("gateway", snapshot.getString("errorDescription"));
        assertEquals("late", snapshot.getString("errorShortMessage"));
        assertEquals("OK", snapshot.getString("statusText"));

        bridge.reply(
                sink.ids.get(0),
                "{\"errorDescription\":null,\"errorShortMessage\":null,\"statusText\":null}"
        );

        assertEquals(1, callback.runs);
        assertSame(event, callback.last);
        assertNull(event.errorDescription);
        assertNull(event.errorShortMessage);
        assertNull(event.statusText);
    }

    @Test
    public void aDisabledDefaultSanitizerLeavesTheTokenQuery() throws Exception {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final String url = "https://api.example/v1/items?token=bugsee-secret-token-value&ok=1";
        final MutableNetwork event = new MutableNetwork(url);
        bridge.ask(event, new RecordingCallback());

        assertEquals(url, event.url);
        assertTrue(sink.json.get(0).contains("bugsee-secret-token-value"));
    }

    @Test
    public void theSanitizerOptionUsesTheCaptureProviderDefault() {
        final OptionsContainer absent = options((key, fallback) -> fallback);
        assertTrue(NetworkFilterBridge.readDefaultSanitizerOption(absent));

        final OptionsContainer off = options((key, fallback) -> Boolean.FALSE);
        assertFalse(NetworkFilterBridge.readDefaultSanitizerOption(off));

        final OptionsContainer on = options((key, fallback) -> Boolean.TRUE);
        assertTrue(NetworkFilterBridge.readDefaultSanitizerOption(on));
    }

    private interface OptionRead {
        Object get(String key, Object fallback);
    }

    private static OptionsContainer options(final OptionRead read) {
        return (OptionsContainer) Proxy.newProxyInstance(
                OptionsContainer.class.getClassLoader(),
                new Class<?>[] { OptionsContainer.class },
                (proxy, method, args) -> {
                    if ("getOption".equals(method.getName()) && args != null && args.length == 2) {
                        assertEquals(Options.CaptureNetworkUseDefaultSanitizer, args[0]);
                        assertEquals(Boolean.TRUE, args[1]);
                        return read.get((String) args[0], args[1]);
                    }
                    return null;
                }
        );
    }
}
