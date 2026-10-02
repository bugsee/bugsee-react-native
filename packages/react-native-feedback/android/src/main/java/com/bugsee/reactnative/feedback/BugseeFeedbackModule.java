package com.bugsee.reactnative.feedback;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.feedback.FeedbackListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;

import java.util.ArrayList;
import java.util.List;

/**
 * The Android half of the {@code BugseeFeedbackModule} TurboModule.
 *
 * <p>Thin on purpose. {@link FeedbackBridge} is what calls
 * {@code Bugsee.ext(Feedback.class)}; this class only forwards the JS wire
 * onto it and emits listener events back. The SDK may call
 * {@code onNewMessagesReceived} on a worker thread, so the emit hops to the
 * UI queue before touching the bridge.
 */
@ReactModule(name = BugseeFeedbackModule.NAME)
public class BugseeFeedbackModule extends NativeBugseeFeedbackSpec {

    public static final String NAME = "BugseeFeedbackModule";

    /**
     * The listener this instance installed. {@code invalidate} clears the SDK
     * only when this is still the one installed: a reload can attach the new
     * module first, and an unconditional null would silence it.
     */
    @Nullable
    private FeedbackListener installedListener;

    /** False after {@code invalidate} or a disable, so a queued callback drops. */
    private volatile boolean acceptingEvents;

    public BugseeFeedbackModule(final ReactApplicationContext context) {
        super(context);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    @Override
    public void invalidate() {
        detachListener();
    }

    @Override
    public void showFeedbackUI() {
        FeedbackBridge.showFeedbackUI();
    }

    @Override
    public void setGreeting(@Nullable final String greeting) {
        FeedbackBridge.setGreeting(greeting);
    }

    @Override
    public void setListenerEnabled(final boolean enabled) {
        if (!enabled) {
            detachListener();
            return;
        }
        acceptingEvents = true;
        final FeedbackListener listener = new FeedbackListener() {
            @Override
            public void onNewMessagesReceived(@Nullable final List<String> newMessages) {
                if (!acceptingEvents) {
                    return;
                }
                final List<String> copy = newMessages == null
                        ? new ArrayList<>()
                        : new ArrayList<>(newMessages);
                emit(() -> {
                    if (!acceptingEvents) {
                        return;
                    }
                    final WritableMap map = Arguments.createMap();
                    map.putString("messagesJson", FeedbackBridge.messagesJson(copy));
                    emitOnNewMessagesReceived(map);
                });
            }

            @Override
            public void onNewMessageSent(@Nullable final String message) {
                if (!acceptingEvents) {
                    return;
                }
                final String copy = message;
                emit(() -> {
                    if (!acceptingEvents) {
                        return;
                    }
                    final WritableMap map = Arguments.createMap();
                    map.putString("message", copy);
                    emitOnNewMessageSent(map);
                });
            }
        };
        installedListener = listener;
        FeedbackBridge.setListener(listener);
    }

    /**
     * Stops this instance emitting, and nulls the SDK listener only when it
     * is still the one this instance installed.
     */
    private void detachListener() {
        acceptingEvents = false;
        final FeedbackListener ours = installedListener;
        installedListener = null;
        if (ours != null) {
            FeedbackBridge.clearListener(ours);
        }
    }

    @Override
    public void setAppearanceColor(
            final String name,
            final double r,
            final double g,
            final double b,
            final double a
    ) {
        FeedbackBridge.setAppearanceColor(name, (int) r, (int) g, (int) b, (int) a);
    }

    private void emit(@NonNull final Runnable body) {
        final ReactApplicationContext context = getReactApplicationContext();
        context.runOnUiQueueThread(() -> {
            if (context.hasActiveReactInstance()) {
                body.run();
            }
        });
    }
}
