package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.Breadcrumb;
import com.bugsee.library.contracts.exchange.EventFilter;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The breadcrumb provider pools entries and does not recycle them on a
 * filter timeout, so this bridge has no deadline. A reply writes the same
 * crumb. A failed filter passes {@code null} and does not leave the original
 * in place by calling the callback with it. {@code level} is
 * {@link Breadcrumb.Level#getValue()}, not the enum ordinal.
 */
public class BreadcrumbFilterBridgeTest {

    /** Counts {@code run} and remembers the argument, including {@code null}. */
    private static final class RecordingCallback implements Callback1<Breadcrumb> {
        int runs;
        @Nullable
        Breadcrumb last;
        boolean sawNull;

        @Override
        public void run(final Breadcrumb value) {
            runs++;
            last = value;
            if (value == null) {
                sawNull = true;
            }
        }
    }

    /** Records the JSON the bridge asked this sink to filter. */
    private static final class RecordingSink implements BreadcrumbFilterBridge.Sink {
        final List<String> ids = new ArrayList<>();
        final List<String> json = new ArrayList<>();
        boolean throwOnEmit;

        @Override
        public void onBreadcrumbFilterRequest(
                @NonNull final String requestId,
                @NonNull final String crumbJson,
                @Nullable final String addId
        ) {
            if (throwOnEmit) {
                throw new IllegalStateException("emit failed");
            }
            ids.add(requestId);
            json.add(crumbJson);
        }
    }

    /**
     * A field the test assigns directly. {@code stick} false makes
     * {@code setCategory} a no-op, the way an interface default would.
     */
    private static final class MutableCrumb implements Breadcrumb {
        @Nullable
        String category;
        @Nullable
        String message;
        @Nullable
        String type;
        @Nullable
        Breadcrumb.Level level;
        @Nullable
        Map<String, Object> data;
        long timestamp;
        boolean stick = true;
        int setCategoryCalls;

        @Override
        public long getTimestamp() {
            return timestamp;
        }

        @Override
        public void setTimestamp(final long timestamp) {
            this.timestamp = timestamp;
        }

        @Override
        @Nullable
        public String getCategory() {
            return category;
        }

        @Override
        public void setCategory(final String category) {
            setCategoryCalls++;
            if (stick) {
                this.category = category;
            }
        }

        @Override
        @Nullable
        public Breadcrumb.Level getLevel() {
            return level;
        }

        @Override
        public void setLevel(final Breadcrumb.Level level) {
            this.level = level;
        }

        @Override
        @Nullable
        public String getMessage() {
            return message;
        }

        @Override
        public void setMessage(final String message) {
            this.message = message;
        }

        @Override
        @Nullable
        public String getType() {
            return type;
        }

        @Override
        public void setType(final String type) {
            this.type = type;
        }

        @Override
        @Nullable
        public Map<String, Object> getData() {
            return data;
        }

        @Override
        public void setData(final Map<String, Object> data) {
            this.data = data;
        }

        @Override
        public void setData(final String key, final Object value) {
            if (data == null) {
                data = new HashMap<>();
            }
            data.put(key, value);
        }
    }

    private final BreadcrumbFilterBridge bridge = new BreadcrumbFilterBridge();

    @Test
    public void snapshotUsesGetValueAndOmitsUnsetKeys() throws Exception {
        assertEquals(3, Breadcrumb.Level.WARNING.getValue());
        assertEquals(2, Breadcrumb.Level.WARNING.ordinal());
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.level = Breadcrumb.Level.WARNING;
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        final JSONObject json = new JSONObject(sink.json.get(0));
        assertEquals("warning", json.getString("level"));
        assertEquals("secret", json.getString("message"));
        assertFalse(json.has("category"));
        assertFalse(json.has("type"));
        assertFalse(json.has("data"));
        assertFalse(json.has("timestamp"));
        assertEquals(0, callback.runs);
    }

    @Test
    public void snapshotIncludesDataAndAStampedTimestamp() throws Exception {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.category = "ui";
        crumb.message = "tap";
        crumb.type = "navigation";
        crumb.level = Breadcrumb.Level.INFO;
        crumb.timestamp = 50L;
        final Map<String, Object> data = new HashMap<>();
        data.put("id", 1);
        data.put("note", null);
        crumb.data = data;
        bridge.ask(crumb, new RecordingCallback());

        final JSONObject json = new JSONObject(sink.json.get(0));
        assertEquals("info", json.getString("level"));
        assertEquals(50L, json.getLong("timestamp"));
        assertEquals(1, json.getJSONObject("data").getInt("id"));
        assertTrue(json.getJSONObject("data").isNull("note"));
    }

    @Test
    public void aReplyWritesGetValueNotTheOrdinal() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.level = Breadcrumb.Level.FATAL;
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        // The name, not getValue() 2 and not the ordinal 2 (WARNING).
        bridge.reply(sink.ids.get(0), "{\"level\":\"info\"}");

        assertEquals(Breadcrumb.Level.INFO, crumb.level);
        assertEquals(1, callback.runs);
        assertSame(crumb, callback.last);
    }

    @Test
    public void aNullReplyDropsWithoutPassingTheCrumbThrough() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        crumb.level = Breadcrumb.Level.ERROR;
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        bridge.reply(sink.ids.get(0), null);

        assertEquals(1, callback.runs);
        assertTrue(callback.sawNull);
        assertNull(callback.last);
        assertEquals("secret", crumb.message);
        assertEquals(Breadcrumb.Level.ERROR, crumb.level);
    }

    @Test
    public void aKeepRewritesTheNamedFieldsAndClearsDataWithNull() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.category = "ui";
        crumb.message = "secret";
        crumb.type = "navigation";
        crumb.level = Breadcrumb.Level.INFO;
        crumb.timestamp = 50L;
        crumb.data = new HashMap<>();
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        bridge.reply(sink.ids.get(0),
                "{\"category\":\"ui\",\"message\":\"redacted\",\"type\":\"navigation\",\"level\":\"error\",\"data\":null}");

        assertEquals("redacted", crumb.message);
        assertEquals(Breadcrumb.Level.ERROR, crumb.level);
        assertNull(crumb.data);
        assertEquals(50L, crumb.timestamp);
        assertEquals(1, callback.runs);
        assertSame(crumb, callback.last);
    }

    @Test
    public void aReplyWritesData() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        bridge.reply(sink.ids.get(0), "{\"data\":{\"id\":1,\"note\":null}}");

        assertEquals(1, callback.runs);
        assertSame(crumb, callback.last);
        assertEquals(1, ((Number) crumb.data.get("id")).intValue());
        assertTrue(crumb.data.containsKey("note"));
        assertNull(crumb.data.get("note"));
        assertEquals("secret", crumb.message);
    }

    @Test
    public void aReplyThatDoesNotStickDropsTheCrumb() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.category = "secret";
        crumb.stick = false;
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        bridge.reply(sink.ids.get(0), "{\"category\":\"redacted\"}");

        assertEquals("secret", crumb.category);
        assertEquals(1, crumb.setCategoryCalls);
        assertEquals(1, callback.runs);
        assertTrue(callback.sawNull);
        assertNull(callback.last);
    }

    @Test
    public void anIntegerLevelDropsTheCrumb() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.level = Breadcrumb.Level.INFO;
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        bridge.reply(sink.ids.get(0), "{\"level\":2}");

        assertEquals(Breadcrumb.Level.INFO, crumb.level);
        assertTrue(callback.sawNull);
        assertNull(callback.last);
    }

    @Test
    public void aMissingSinkDropsWithoutAsking() {
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);
        assertTrue(callback.sawNull);
        assertEquals("secret", crumb.message);
    }

    @Test
    public void aFailedEmitDropsAndALaterReplyIsANoOp() {
        final RecordingSink sink = new RecordingSink();
        sink.throwOnEmit = true;
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        assertTrue(callback.sawNull);
        assertEquals("secret", crumb.message);
        bridge.reply("1", "{\"message\":\"redacted\"}");
        assertEquals("secret", crumb.message);
        assertEquals(1, callback.runs);
    }

    @Test
    public void detachDropsAPendingCrumbAndALaterReplyDoesNotWriteIt() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);
        final String id = sink.ids.get(0);

        bridge.detach(sink);

        assertTrue(callback.sawNull);
        assertEquals("secret", crumb.message);
        bridge.reply(id, "{\"message\":\"redacted\"}");
        assertEquals("secret", crumb.message);
        assertEquals(1, callback.runs);
    }

    @Test
    public void aSecondReplyIsANoOp() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);
        final String id = sink.ids.get(0);

        bridge.reply(id, "{\"message\":\"redacted\"}");
        bridge.reply(id, "{\"message\":\"later\"}");

        assertEquals("redacted", crumb.message);
        assertEquals(1, callback.runs);
        assertSame(crumb, callback.last);
    }

    @Test
    public void dataThatCannotBeSerialisedDropsTheCrumb() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        bridge.arm();
        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final Map<String, Object> data = new HashMap<>();
        data.put("when", new Object());
        crumb.data = data;
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        assertTrue(sink.ids.isEmpty());
        assertTrue(callback.sawNull);
        assertEquals("secret", crumb.message);
    }

    @Test
    public void aNewModuleThatHasNotArmedDropsTheCrumbAtOnce() {
        final RecordingSink old = new RecordingSink();
        bridge.attach(old);
        bridge.arm();
        final RecordingSink next = new RecordingSink();
        bridge.attach(next);

        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        assertEquals(0, next.json.size());
        assertEquals(1, callback.runs);
        assertTrue(callback.sawNull);
    }

    @Test
    public void armingAgainAsksTheNewModule() {
        final RecordingSink next = new RecordingSink();
        bridge.attach(next);
        bridge.arm();

        final MutableCrumb crumb = new MutableCrumb();
        crumb.message = "secret";
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(crumb, callback);

        assertEquals(1, next.json.size());
        assertEquals(0, callback.runs);
    }

    /** A late enable from the module a reload replaced must not arm the new, unsubscribed runtime. */
    @Test
    public void aStaleModulesEnableDoesNotArmTheNewModule() {
        final RecordingSink old = new RecordingSink();
        bridge.attach(old);
        final RecordingSink next = new RecordingSink();
        bridge.attach(next);
        bridge.arm(old);

        final MutableCrumb ev = new MutableCrumb();
        ev.message = "secret";
        final RecordingCallback dropped = new RecordingCallback();
        bridge.ask(ev, dropped);
        assertEquals(0, next.json.size());
        assertEquals(1, dropped.runs);

        bridge.arm(next);
        final RecordingCallback asked = new RecordingCallback();
        bridge.ask(ev, asked);
        assertEquals(1, next.json.size());
        assertEquals(0, asked.runs);
    }

    // The startup hold (#134): the SDK's filter is installed before JS exists.
    private final List<EventFilter<Breadcrumb>> installs = new ArrayList<>();

    private BreadcrumbFilterBridge installing() {
        return new BreadcrumbFilterBridge(installs::add);
    }

    @Test
    public void holdUntilJsInstallsTheFilterOnceAndDropsBeforeAnyModule() {
        final BreadcrumbFilterBridge held = installing();

        held.holdUntilJs();
        held.holdUntilJs();

        assertEquals(1, installs.size());
        assertTrue(held.isHeld());
        final RecordingCallback callback = new RecordingCallback();
        installs.get(0).filter(new MutableCrumb(), callback);
        assertEquals(1, callback.runs);
        assertTrue(callback.sawNull);
    }

    @Test
    public void aHeldBridgeDropsAtOnceWhileAModuleIsAttachedButNotArmed() {
        final BreadcrumbFilterBridge held = installing();
        final RecordingSink sink = new RecordingSink();
        held.holdUntilJs();
        held.attach(sink);
        final RecordingCallback callback = new RecordingCallback();

        held.ask(new MutableCrumb(), callback);

        // Nothing is left pending for a reply that cannot come.
        assertTrue(sink.ids.isEmpty());
        assertTrue(callback.sawNull);
    }

    @Test
    public void setBreadcrumbFilterWithNullRemovesTheHeldFilter() {
        final BreadcrumbFilterBridge held = installing();
        final RecordingSink sink = new RecordingSink();
        held.holdUntilJs();
        held.attach(sink);

        held.setEnabled(false, sink);

        assertFalse(held.isHeld());
        assertEquals(2, installs.size());
        assertNull(installs.get(1));
    }

    @Test
    public void setBreadcrumbFilterWithAFunctionKeepsTheInstalledFilterAndArmsIt() {
        final BreadcrumbFilterBridge held = installing();
        final RecordingSink sink = new RecordingSink();
        held.holdUntilJs();
        held.attach(sink);

        held.setEnabled(true, sink);

        assertFalse(held.isHeld());
        assertEquals(1, installs.size());
        held.ask(new MutableCrumb(), new RecordingCallback());
        assertEquals(1, sink.ids.size());
    }

    @Test
    public void aSupersededModuleCannotReleaseTheBreadcrumbHold() {
        final BreadcrumbFilterBridge held = installing();
        final RecordingSink old = new RecordingSink();
        held.holdUntilJs();
        held.attach(old);
        held.attach(new RecordingSink());

        held.setEnabled(false, old);

        assertTrue(held.isHeld());
    }

    @Test
    public void aBridgeThatWasNeverHeldReportsNotHeld() {
        assertFalse(installing().isHeld());
    }

    @Test
    public void aFailedEarlyInstallIsRetriedByTheNextSetEnabled() {
        final int[] attempts = {0};
        final java.util.function.Consumer<EventFilter<Breadcrumb>> failingOnce = filter -> {
            attempts[0]++;
            if (attempts[0] == 1) {
                throw new IllegalStateException("SDK not ready");
            }
            installs.add(filter);
        };
        final BreadcrumbFilterBridge bridge2 = new BreadcrumbFilterBridge(failingOnce);
        final RecordingSink sink = new RecordingSink();
        bridge2.attach(sink);

        try {
            bridge2.holdUntilJs();
            org.junit.Assert.fail("the install failure is rethrown for StartupHold to log");
        } catch (final IllegalStateException expected) {
            // StartupHold logs it and goes on.
        }
        // Not installed, so not reported as held.
        assertFalse(bridge2.isHeld());

        bridge2.setEnabled(true, sink);

        assertEquals(2, attempts[0]);
        assertEquals(1, installs.size());
    }
}
