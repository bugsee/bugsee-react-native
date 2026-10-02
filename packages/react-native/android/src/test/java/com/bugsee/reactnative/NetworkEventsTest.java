package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.exchange.NetworkEvent;

import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;

/**
 * A network event the app records itself is built by the SDK exchange
 * factory and handed back with filtering required. {@code Bugsee.getLaunchOptions}
 * is not on this path: a plain JVM test can drive the factory seam.
 */
public class NetworkEventsTest {

    private static final class CreateCall {
        long timestamp;
        NetworkEvent.NetworkEventStage stage;
        String eventId;
        String mechanism;
        String method;
        int calls;
    }

    private static final class RecordingFactory implements NetworkEvents.Factory {
        final CreateCall call = new CreateCall();
        @Nullable NetworkEvent event = recordingEvent();
        boolean missing;

        @Override
        @Nullable
        public NetworkEvent create(
                final long timestamp,
                @NonNull final NetworkEvent.NetworkEventStage stage,
                @Nullable final String eventId,
                @Nullable final String mechanism,
                @Nullable final String method
        ) {
            call.calls += 1;
            call.timestamp = timestamp;
            call.stage = stage;
            call.eventId = eventId;
            call.mechanism = mechanism;
            call.method = method;
            return missing ? null : event;
        }
    }

    private static final class RecordingRecorder implements NetworkEvents.Recorder {
        int calls;
        NetworkEvent event;
        boolean requiresFiltering;

        @Override
        public void add(@NonNull final NetworkEvent event, final boolean requiresFiltering) {
            calls += 1;
            this.event = event;
            this.requiresFiltering = requiresFiltering;
        }
    }

    @Test
    public void completedIsRequestCompletedAndFilteringIsRequired() {
        final RecordingFactory factory = new RecordingFactory();
        final RecordingRecorder recorder = new RecordingRecorder();
        final NetworkEvents.Outcome outcome = NetworkEvents.record(
                "{\"url\":\"https://e2e.example/keep\",\"method\":\"GET\",\"stage\":\"completed\"}",
                factory,
                recorder,
                () -> 1_700_000_000_000L
        );

        assertSame(NetworkEvents.Outcome.ADDED, outcome);
        assertEquals(1, factory.call.calls);
        assertEquals(1_700_000_000_000L, factory.call.timestamp);
        assertSame(NetworkEvent.NetworkEventStage.RequestCompleted, factory.call.stage);
        assertEquals("react-native", factory.call.mechanism);
        assertEquals("GET", factory.call.method);
        assertNull(factory.call.eventId);
        assertEquals(1, recorder.calls);
        assertTrue(recorder.requiresFiltering);
        assertEquals("https://e2e.example/keep", recorder.event.getUrl());
    }

    @Test
    public void theNativeCompleteNameIsTheSameStage() {
        final RecordingFactory factory = new RecordingFactory();
        NetworkEvents.record(
                "{\"url\":\"https://e2e.example/keep\",\"method\":\"POST\",\"stage\":\"complete\"}",
                factory,
                new RecordingRecorder(),
                () -> 0L
        );
        assertSame(NetworkEvent.NetworkEventStage.RequestCompleted, factory.call.stage);
        assertEquals("POST", factory.call.method);
    }

    @Test
    public void anUnknownStageIsNotRecorded() {
        final RecordingFactory factory = new RecordingFactory();
        final RecordingRecorder recorder = new RecordingRecorder();
        final NetworkEvents.Outcome outcome = NetworkEvents.record(
                "{\"url\":\"https://e2e.example/keep\",\"method\":\"GET\",\"stage\":\"done\"}",
                factory,
                recorder,
                () -> 0L
        );
        assertSame(NetworkEvents.Outcome.REJECTED, outcome);
        assertEquals(0, factory.call.calls);
        assertEquals(0, recorder.calls);
    }

    @Test
    public void aMissingFactoryOrANullEventDropsWithoutAdding() {
        final RecordingRecorder recorder = new RecordingRecorder();
        assertSame(
                NetworkEvents.Outcome.NO_EVENT,
                NetworkEvents.record(
                        "{\"url\":\"https://e2e.example/keep\",\"method\":\"GET\",\"stage\":\"completed\"}",
                        null,
                        recorder,
                        () -> 0L
                )
        );
        final RecordingFactory factory = new RecordingFactory();
        factory.missing = true;
        assertSame(
                NetworkEvents.Outcome.NO_EVENT,
                NetworkEvents.record(
                        "{\"url\":\"https://e2e.example/keep\",\"method\":\"GET\",\"stage\":\"completed\"}",
                        factory,
                        recorder,
                        () -> 0L
                )
        );
        assertEquals(0, recorder.calls);
    }

    @Test
    public void writableFilterFieldsAreSetOnTheEvent() {
        final RecordingFactory factory = new RecordingFactory();
        final RecordingRecorder recorder = new RecordingRecorder();
        NetworkEvents.record(
                "{\"url\":\"https://e2e.example/keep\",\"method\":\"POST\",\"stage\":\"error\","
                        + "\"id\":\"evt-1\",\"body\":\"secret\","
                        + "\"headers\":{\"Authorization\":\"Bearer x\"},"
                        + "\"responseCode\":201,\"statusText\":\"Created\","
                        + "\"errorDescription\":\"none\",\"errorShortMessage\":\"ok\"}",
                factory,
                recorder,
                () -> 5L
        );
        assertSame(NetworkEvent.NetworkEventStage.RequestErrored, factory.call.stage);
        assertEquals("evt-1", factory.call.eventId);
        final NetworkEvent event = recorder.event;
        assertEquals("secret", event.getBody());
        assertEquals("Bearer x", event.getHeaders().get("Authorization"));
        assertEquals(201, event.getResponseCode());
        assertEquals("Created", event.getStatusText());
        assertEquals("none", event.getErrorDescription());
        assertEquals("ok", event.getErrorShortMessage());
        assertTrue(recorder.requiresFiltering);
    }

    @Test
    public void aNullBodyClearsTheBody() {
        final RecordingFactory factory = new RecordingFactory();
        final RecordingRecorder recorder = new RecordingRecorder();
        NetworkEvents.record(
                "{\"url\":\"https://e2e.example/keep\",\"method\":\"GET\",\"stage\":\"completed\",\"body\":null}",
                factory,
                recorder,
                () -> 0L
        );
        assertNull(recorder.event.getBody());
        assertTrue(recorder.requiresFiltering);
    }

    private static NetworkEvent recordingEvent() {
        final Map<String, Object> values = new HashMap<>();
        return (NetworkEvent) Proxy.newProxyInstance(
                NetworkEvent.class.getClassLoader(),
                new Class<?>[] { NetworkEvent.class },
                (proxy, method, args) -> {
                    final String name = method.getName();
                    if (name.startsWith("set") && args != null && args.length == 1) {
                        values.put(name.substring(3), args[0]);
                        return null;
                    }
                    if (name.startsWith("get") || name.startsWith("is")) {
                        final String key = name.startsWith("get") ? name.substring(3) : name.substring(2);
                        if (values.containsKey(key)) {
                            return values.get(key);
                        }
                    }
                    if (method.getReturnType() == int.class || method.getReturnType() == long.class) {
                        return 0;
                    }
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    }
                    return null;
                }
        );
    }
}
