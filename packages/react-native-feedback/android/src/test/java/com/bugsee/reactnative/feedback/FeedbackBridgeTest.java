package com.bugsee.reactnative.feedback;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.appearance.FeedbackAppearance;
import com.bugsee.library.contracts.extensions.Extension;
import com.bugsee.library.contracts.extensions.Feedback;
import com.bugsee.library.contracts.feedback.FeedbackListener;
import com.bugsee.library.contracts.options.OptionsContainer;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class FeedbackBridgeTest {

    /**
     * A stand-in registered through {@code Bugsee.registerExt}, so the
     * assertions go through the real {@code Bugsee.ext(Feedback.class)} lookup
     * rather than a seam that could call something else.
     */
    private static final class RecordingFeedback implements Feedback {
        boolean shown;
        @Nullable String greeting;
        boolean greetingSet;
        @Nullable FeedbackListener listener;
        boolean listenerSet;

        @NonNull
        @Override
        public Class<? extends Extension> getType() {
            return Feedback.class;
        }

        @Override
        public void launch(@NonNull final OptionsContainer options) {
        }

        @Override
        public void stop() {
        }

        @Override
        public void showFeedbackActivity() {
            shown = true;
        }

        @Override
        public void setDefaultFeedbackGreeting(@Nullable final String greeting) {
            this.greeting = greeting;
            greetingSet = true;
        }

        @Override
        public void setOnNewFeedbackListener(@Nullable final FeedbackListener listener) {
            this.listener = listener;
            listenerSet = true;
        }
    }

    @Test
    public void extFeedbackClassReceivesTheThreeCalls() {
        // Nothing else in this process registers Feedback, so this is null
        // until the registerExt below. The three calls must not throw when
        // the extension is absent: the artifact's ContentProvider has not
        // run in a JVM test, and a missing one on a device is a no-op rather
        // than a crash.
        assertNull(FeedbackBridge.extension());
        FeedbackBridge.showFeedbackUI();
        FeedbackBridge.setGreeting("nope");
        FeedbackBridge.setListener(null);

        final RecordingFeedback feedback = new RecordingFeedback();
        Bugsee.registerExt(Feedback.class, feedback);
        assertSame(feedback, FeedbackBridge.extension());

        FeedbackBridge.showFeedbackUI();
        assertTrue(feedback.shown);

        FeedbackBridge.setGreeting("hello");
        assertEquals("hello", feedback.greeting);
        FeedbackBridge.setGreeting(null);
        assertNull(feedback.greeting);
        assertTrue(feedback.greetingSet);

        final FeedbackListener listener = silentListener();
        FeedbackBridge.setListener(listener);
        assertSame(listener, feedback.listener);
        FeedbackBridge.setListener(null);
        assertNull(feedback.listener);
        assertTrue(feedback.listenerSet);

        // A reload installs the new module's listener before the old
        // invalidate. Clearing the old one must leave the new one in place.
        final FeedbackListener replacement = silentListener();
        FeedbackBridge.setListener(listener);
        FeedbackBridge.setListener(replacement);
        assertFalse(FeedbackBridge.clearListener(listener));
        assertSame(replacement, feedback.listener);
        assertTrue(FeedbackBridge.clearListener(replacement));
        assertNull(feedback.listener);
        assertFalse(FeedbackBridge.clearListener(replacement));
    }

    private static FeedbackListener silentListener() {
        return new FeedbackListener() {
            @Override
            public void onNewMessagesReceived(@Nullable final List<String> newMessages) {
            }

            @Override
            public void onNewMessageSent(@Nullable final String message) {
            }
        };
    }

    @Test
    public void setColorStoresTheFeedbackAppearanceConstant() {
        final int packed = FeedbackBridge.packArgb(0x11, 0x22, 0x33, 0x44);
        FeedbackBridge.setAppearanceColor(FeedbackAppearance.IncomingBubbleColor, 0x11, 0x22, 0x33, 0x44);
        assertEquals(
                Integer.valueOf(packed),
                Bugsee.getAppearance().getColor(FeedbackAppearance.IncomingBubbleColor));
        assertEquals("Feedback::IncomingBubbleColor", FeedbackAppearance.IncomingBubbleColor);
    }

    @Test
    public void packArgbUsesAndroidChannelOrder() {
        assertEquals(0xFF000000, FeedbackBridge.packArgb(0, 0, 0, 255));
        assertEquals(0xFFFF0000, FeedbackBridge.packArgb(255, 0, 0, 255));
        assertEquals(0x44223311, FeedbackBridge.packArgb(0x22, 0x33, 0x11, 0x44));
    }

    @Test
    public void anOutOfRangeComponentDoesNotReplaceTheStoredColor() {
        FeedbackBridge.setAppearanceColor(FeedbackAppearance.BackgroundColor, 1, 2, 3, 4);
        final Integer before = Bugsee.getAppearance().getColor(FeedbackAppearance.BackgroundColor);
        try {
            FeedbackBridge.setAppearanceColor(FeedbackAppearance.BackgroundColor, 256, 0, 0, 255);
            throw new AssertionError("expected IllegalArgumentException");
        } catch (final IllegalArgumentException expected) {
            // The range, never the component that was out of it.
            assertEquals("color component out of range 0..255", expected.getMessage());
        }
        assertEquals(before, Bugsee.getAppearance().getColor(FeedbackAppearance.BackgroundColor));
    }

    @Test
    public void anEmptyPropertyIsRejected() {
        try {
            FeedbackBridge.setAppearanceColor("", 0, 0, 0, 255);
            throw new AssertionError("expected IllegalArgumentException");
        } catch (final IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("empty"));
        }
    }

    @Test
    public void messagesJsonOmitsNullsAndKeepsTheRest() {
        assertEquals("[]", FeedbackBridge.messagesJson(null));
        assertEquals("[]", FeedbackBridge.messagesJson(Collections.emptyList()));
        assertEquals("[\"a\",\"b\"]", FeedbackBridge.messagesJson(Arrays.asList("a", "b")));
        assertEquals("[\"c\"]", FeedbackBridge.messagesJson(Arrays.asList(null, "c")));
        assertEquals("[\"a\",\"b\"]", FeedbackBridge.messagesJson(Arrays.asList("a", null, "b")));
        assertEquals("[]", FeedbackBridge.messagesJson(Arrays.asList(null, null)));
    }
}
