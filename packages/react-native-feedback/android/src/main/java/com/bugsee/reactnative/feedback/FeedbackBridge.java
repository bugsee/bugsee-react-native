package com.bugsee.reactnative.feedback;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.appearance.Appearance;
import com.bugsee.library.contracts.extensions.Feedback;
import com.bugsee.library.contracts.feedback.FeedbackListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * The one place this package calls {@code Bugsee.ext(Feedback.class)}.
 *
 * <p>Android's feedback artifact names the methods
 * {@code showFeedbackActivity}, {@code setDefaultFeedbackGreeting} and
 * {@code setOnNewFeedbackListener}. The JS names ({@code showFeedbackUI},
 * {@code setGreeting}, {@code setListener}) are the iOS ones; this class is
 * the translation. Colors go through {@code Bugsee.getAppearance().setColor}
 * with a {@code FeedbackAppearance} constant ({@code Feedback::…}), which
 * lives in the feedback artifact rather than in the core SDK.
 */
public final class FeedbackBridge {

    private FeedbackBridge() {
    }

    @Nullable
    static Feedback extension() {
        return Bugsee.ext(Feedback.class);
    }

    public static void showFeedbackUI() {
        final Feedback feedback = extension();
        if (feedback == null) {
            return;
        }
        feedback.showFeedbackActivity();
    }

    public static void setGreeting(@Nullable final String greeting) {
        final Feedback feedback = extension();
        if (feedback == null) {
            return;
        }
        feedback.setDefaultFeedbackGreeting(greeting);
    }

    public static void setListener(@Nullable final FeedbackListener listener) {
        final Feedback feedback = extension();
        if (feedback == null) {
            return;
        }
        feedback.setOnNewFeedbackListener(listener);
    }

    /**
     * A JSON array of the message strings, in the order the SDK handed them
     * over. {@code null} entries become JSON null. A null list is {@code []}.
     */
    @NonNull
    public static String messagesJson(@Nullable final List<String> messages) {
        final JSONArray array = new JSONArray();
        if (messages != null) {
            for (final String message : messages) {
                // Android's org.json rejects put(null). JSONObject.NULL is
                // the null both that copy and the test's org.json render as
                // a JSON null.
                array.put(message == null ? JSONObject.NULL : message);
            }
        }
        return array.toString();
    }

    /**
     * {@code property} is a {@code FeedbackAppearance} constant value, such as
     * {@code FeedbackAppearance.IncomingBubbleColor}
     * ({@code Feedback::IncomingBubbleColor}). Components are 0–255.
     */
    public static void setAppearanceColor(
            @NonNull final String property,
            final int r,
            final int g,
            final int b,
            final int a
    ) {
        if (property.length() == 0) {
            throw new IllegalArgumentException("feedback appearance property is empty");
        }
        checkComponent(r);
        checkComponent(g);
        checkComponent(b);
        checkComponent(a);
        final Appearance appearance = Bugsee.getAppearance();
        appearance.setColor(property, packArgb(r, g, b, a));
    }

    static int packArgb(final int r, final int g, final int b, final int a) {
        return (a & 0xff) << 24 | (r & 0xff) << 16 | (g & 0xff) << 8 | (b & 0xff);
    }

    private static void checkComponent(final int value) {
        if (value < 0 || value > 255) {
            throw new IllegalArgumentException("color component out of range: " + value);
        }
    }
}
