package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Base64;
import android.util.Log;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.exchange.Breadcrumb;
import com.bugsee.library.contracts.exchange.BugseeExchangeFactory;
import com.bugsee.library.contracts.options.IssueSeverity;
import com.bugsee.library.contracts.options.Options;
import com.bugsee.library.contracts.options.OptionsContainer;
import com.bugsee.library.contracts.performance.Span;
import com.bugsee.library.contracts.performance.SpanStatus;
import com.bugsee.library.contracts.performance.Transaction;
import com.bugsee.library.contracts.reporting.Report;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * The Android half of the `Bugsee` TurboModule.
 *
 * <p>Thin on purpose. Everything that translates between the JS wire shape and
 * the SDK's types lives in {@link BugseeTokens}, {@link BugseeStatusMapper},
 * {@link ReportOps}, {@link ReportHandlerBridge} and {@link CreatedReports}, which are plain Java and
 * unit-tested without React Native or a device; what is left here is the part
 * that can only be exercised by running the app, and is covered by the example
 * app's e2e instead.
 */
@ReactModule(name = BugseeModule.NAME)
public class BugseeModule extends NativeBugseeSpec
        implements WrapperEventBus.Sink, ReportHandlerBridge.Sink, NetworkFilterBridge.Sink,
            LogFilterBridge.Sink, BreadcrumbFilterBridge.Sink {

    public static final String NAME = "Bugsee";

    /** The wrapper's log tag, as ReportHandlerBridge and WrapperEventBus use. */
    private static final String TAG = "BugseeRN";

    /** Production adapter: the SDK's handled / unhandled entry points. */
    private static final ExceptionBridge.Sdk PROD_EXCEPTION_SDK = new ExceptionBridge.Sdk() {
        @Override
        public void logException(final Throwable t, @Nullable final Map<String, Object> options) {
            Bugsee.logException(t, options);
        }

        @Override
        public void logUnhandledException(
                final Throwable t,
                @Nullable final Map<String, Object> options
        ) {
            Bugsee.logUnhandledException(t, options);
        }
    };

    // The stable codes of src/report/errors.ts. An app matches on these.
    private static final String E_REPORT_HANDLE_DEAD = "E_REPORT_HANDLE_DEAD";
    private static final String E_REPORT_ATTACHMENT_REJECTED = "E_REPORT_ATTACHMENT_REJECTED";
    private static final String E_REPORT_BAD_ARGUMENT = "E_REPORT_BAD_ARGUMENT";
    private static final String E_REPORT_CREATE_BUSY = "E_REPORT_CREATE_BUSY";
    // The stable code of src/attributes/errors.ts's AttributeErrorCode.Rejected.
    private static final String E_ATTRIBUTE_REJECTED = "E_ATTRIBUTE_REJECTED";

    /** Moves secure rectangles from React Native's viewport space to display pixels. */
    private final ReactRootOriginTracker originTracker;

    /**
     * What the SDK's secure-rectangle pull calls to refresh the origin. One
     * instance, held, so invalidate() can remove exactly this one.
     */
    private final Runnable pullRefresher;

    /**
     * The one {@link DataRequestBridge.Sink} this module hands to the bridge,
     * held so {@code invalidate()} can detach exactly this instance -- a
     * fresh {@code this::emitRequest} reference at that call site would not
     * be the same object the bridge was attached with.
     */
    private final DataRequestBridge.Sink dataRequestSink = this::emitRequest;

    /** Spans this module is holding. {@link #invalidate()} drops them. */
    private final SpanHandles spanHandles = new SpanHandles();

    public BugseeModule(final ReactApplicationContext context) {
        super(context);
        originTracker = new ReactRootOriginTracker(context, SecureRectangleStore.shared());
        // refreshSoon only posts to the UI thread, which is all the SDK's pull
        // thread may do.
        pullRefresher = originTracker::refreshSoon;
        SecureRectanglePulls.shared().setRefresher(pullRefresher);
        // Attached here, not on first subscribe: the SDK may emit before any JS
        // has run, and a listener that only exists once JS asks for it would
        // miss the launch transitions that a caller most wants.
        WrapperEventBus.shared().attach(this);
        ReportHandlerBridge.shared().attach(this);
        DataRequestBridge.shared().attach(dataRequestSink, originTracker::currentOrigin);
        NetworkFilterBridge.shared().attach(this);
        LogFilterBridge.shared().attach(this);
        // The echo drop is installed even when the app never calls setLogFilter.
        // setEnabled(false) is that pass-through; it does not remove the filter.
        LogFilterBridge.shared().setEnabled(false);
        BreadcrumbFilterBridge.shared().attach(this);
    }

    /**
     * Detaches from the event bus and the report handler bridge when the
     * bridge goes away.
     *
     * <p>Identity-checked inside both: a reload can construct and attach the
     * NEW module before this one is invalidated, and an unconditional clear
     * would then silence the live bridge. Emitting into a dead module is the
     * classic React Native leak, so this is not optional.
     */
    @Override
    public void invalidate() {
        WrapperEventBus.shared().detach(this);
        // Also completes every report handle this module's JS was given: the
        // next runtime cannot know them, so the reports must not wait out
        // their deadlines.
        ReportHandlerBridge.shared().detach(this);
        // The next runtime cannot know a created-report handle. Drop it and
        // free the one slot before that runtime reserves its own.
        CreatedReports.shared().clear();
        // Same for any outstanding vh request, and disables the view tree:
        // the next runtime's anchor has not mounted yet.
        DataRequestBridge.shared().detach(dataRequestSink);
        NetworkFilterBridge.shared().detach(this);
        // Drops every log-filter request this module was given. An unanswered
        // one would otherwise sit until the SDK's timeout, and a reply into
        // this module after it is gone has nowhere to land.
        LogFilterBridge.shared().detach(this);
        // Drops every breadcrumb-filter request this module was given. An
        // unanswered one is not recorded; a reply into this module after it
        // is gone has nowhere to land.
        BreadcrumbFilterBridge.shared().detach(this);
        // The next runtime cannot know these handles. Drop them without
        // finishing: a reload must not close a transaction the SDK still has.
        spanHandles.releaseAll();
        SecureRectanglePulls.shared().clearRefresher(pullRefresher);
        originTracker.dispose();
        super.invalidate();
    }

    @Override
    public void onLifecycleEvent(@NonNull final String name, @Nullable final String reportId) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("name", name);
        // Present only for the events that carry one, rather than null for the
        // rest: the JS type marks it optional, and a null would force every
        // caller to distinguish "absent" from "explicitly nothing".
        if (reportId != null) {
            payload.putString("reportId", reportId);
        }
        emitOnLifecycleEvent(payload);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    @Override
    public void launch(final String token, final ReadableMap options, final Promise promise) {
        if (!BugseeTokens.isUsable(token)) {
            promise.reject("E_TOKEN", "Bugsee.launch requires a non-empty app token");
            return;
        }
        // The Application, not the React context: the SDK registers activity
        // lifecycle callbacks on it and outlives any single React instance.
        Bugsee.launch(
                getReactApplicationContext().getApplicationContext(),
                token,
                toOptions(options),
                // The SDK reports whether it actually started. Declining — it
                // is already running, or the token was rejected — is a normal
                // outcome, so it resolves false rather than rejecting.
                launched -> {
                    // launch can replace the log filter. Put the pass-through
                    // (or the user filter, if one is already on) back.
                    LogFilterBridge.shared().ensureInstalled();
                    promise.resolve(Boolean.TRUE.equals(launched));
                });
    }

    @Override
    public void relaunch(final ReadableMap options, final Promise promise) {
        Bugsee.relaunch(toOptions(options), relaunched -> {
            LogFilterBridge.shared().ensureInstalled();
            promise.resolve(Boolean.TRUE.equals(relaunched));
        });
    }

    @Override
    public void stop(final Promise promise) {
        Bugsee.stop(() -> promise.resolve(true));
    }

    @Override
    public void getStatus(final Promise promise) {
        promise.resolve(BugseeStatusMapper.toWire(Bugsee.getStatus()));
    }

    @Override
    public void setWrapperInfo(final ReadableMap identity) {
        if (identity == null) {
            WrapperRegistrar.register(null);
            return;
        }
        final ReadableMap context = identity.hasKey("context")
                ? identity.getMap("context")
                : null;
        // A new instance, so the SDK hands it a fresh channel and retires the
        // provider's. Through the registrar: the provider registered on
        // another thread, and the spec forbids registrations overlapping.
        WrapperRegistrar.register(new BugseeReactNativeWrapper(
                string(identity, "type", "unknown"),
                string(identity, "version", "unknown"),
                identity.hasKey("build") ? identity.getString("build") : null,
                toStringMap(context)));
    }

    @Override
    public void setSecureRectangles(final double display, final ReadableArray coordinates) {
        // A void TurboModule method: anything thrown here has no promise to
        // reject and crashes the host app, over a call JS already validated.
        try {
            // Codegen hands numbers across as double, because that is what a
            // JS number is. Rounding rather than truncating: the JS side has
            // already rounded each edge outwards, and truncating -0.9999 to 0
            // would pull an edge back inside the region it was widened to
            // cover.
            final int[] flat = new int[coordinates == null ? 0 : coordinates.size()];
            for (int i = 0; i < flat.length; i++) {
                flat[i] = (int) Math.round(coordinates.getDouble(i));
            }
            // Stored as measured (relative to React Native's viewport
            // offset); the store serves them moved to the React root's
            // display origin, which the tracker keeps current. Re-read now
            // too, in case the window moved without a layout pass.
            if (!SecureRectangleStore.shared().publishOrLog((int) display, flat)) {
                return;
            }
            originTracker.refreshSoon();
            if (Log.isLoggable(TAG, Log.DEBUG)) {
                Log.d(TAG, "secure published display=" + (int) display
                        + " raw=" + Arrays.toString(flat)
                        + " served=" + Arrays.toString(SecureRectangleStore.shared().snapshot((int) display)));
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "setSecureRectangles failed; the previous set stays published: "
                    + e.getClass().getName());
        }
    }

    // --- Blackout and view-hierarchy capture (design doc §4.1) -----------
    // Android ignores startBlackout/endBlackout before launch() (a logged
    // no-op inside the SDK itself); iOS honours them regardless. Recorded in
    // the plan as a candidate SDK issue, not patched here -- see the Phase 6
    // preamble's "Planner decisions".

    @Override
    public void startBlackout() {
        Bugsee.startBlackout();
    }

    @Override
    public void endBlackout() {
        Bugsee.endBlackout();
    }

    @Override
    public void isBlackout(final Promise promise) {
        promise.resolve(Bugsee.isBlackout());
    }

    @Override
    public void captureViewHierarchy() {
        Bugsee.captureViewHierarchy();
    }

    // --- View-hierarchy data request (design doc, Phase 6 / Task 6.5) ------
    // DataRequestBridge owns the exactly-once, within-deadline contract with
    // the SDK; this is only the translation to and from its Sink/emit shape,
    // mirroring ReportHandlerBridge's onReportHandlerRequest below.

    /**
     * Builds the {@code onDataRequest} payload and emits it. {@code
     * originX}/{@code originY} cross as doubles because codegen types the
     * TS event's fields as {@code number} -- there is no separate integer
     * wire type.
     */
    private void emitRequest(final String requestId, final String type, final int originX, final int originY) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("requestId", requestId);
        payload.putString("type", type);
        payload.putDouble("originX", originX);
        payload.putDouble("originY", originY);
        emitOnDataRequest(payload);
    }

    @Override
    public void setViewTreeEnabled(final boolean enabled) {
        DataRequestBridge.shared().setViewTreeEnabled(dataRequestSink, enabled);
    }

    @Override
    public void replyDataRequest(final String requestId, @Nullable final String payload) {
        DataRequestBridge.shared().complete(requestId, payload);
    }

    private static String string(
            @NonNull final ReadableMap map,
            @NonNull final String key,
            @NonNull final String fallback
    ) {
        final String value = map.hasKey(key) ? map.getString(key) : null;
        return value == null ? fallback : value;
    }

    /**
     * The SDK types context as string-to-string. A non-string value would be
     * dropped rather than stringified: a number rendered as "1" is
     * indistinguishable from a version the wrapper actually reported.
     */
    private static Map<String, String> toStringMap(@Nullable final ReadableMap map) {
        final Map<String, String> result = new HashMap<>();
        if (map == null) {
            return result;
        }
        final ReadableMapKeySetIterator keys = map.keySetIterator();
        while (keys.hasNextKey()) {
            final String key = keys.nextKey();
            if (map.getType(key) == ReadableType.String) {
                result.put(key, map.getString(key));
            }
        }
        return result;
    }

    @Override
    public void getLaunchOptions(final Promise promise) {
        // Android's container is valid before launch too, in which case it
        // holds the SDK's own defaults -- so this answers a getter that the
        // app has not overridden, without the wrapper hardcoding anything.
        promise.resolve(toWritableMap(Bugsee.getLaunchOptions().toMap()));
    }

    @Override
    public void testCrash() {
        Bugsee.testCrash();
    }

    /**
     * A handled JS exception. Posted onto {@link ExceptionExecutors#HANDLED}:
     * the SDK must not run on the native-modules thread.
     */
    @Override
    public void logException(final String payloadJson, final @Nullable String optionsJson) {
        ExceptionExecutors.HANDLED.execute(() -> {
            try {
                ExceptionBridge.logHandled(PROD_EXCEPTION_SDK, payloadJson, optionsJson);
                Log.i(TAG, "exception handled sent bytes="
                        + (payloadJson == null ? 0 : payloadJson.length()));
            } catch (final RuntimeException e) {
                Log.e(TAG, "logException failed: " + e.getClass().getName());
            }
        });
    }

    /**
     * An unhandled JS exception. Posted onto {@link ExceptionExecutors#UNHANDLED},
     * not behind handled reports: JS waits at most 1500 ms. The promise
     * resolves {@code null} exactly once in a {@code finally} after that
     * background call returns, including when the SDK throws.
     */
    @Override
    public void logUnhandledException(final String payloadJson, final Promise promise) {
        ExceptionExecutors.UNHANDLED.execute(() -> {
            try {
                ExceptionBridge.logUnhandled(PROD_EXCEPTION_SDK, payloadJson);
                Log.i(TAG, "exception unhandled sent bytes="
                        + (payloadJson == null ? 0 : payloadJson.length()));
                Log.i(TAG, "exception unhandled completed");
            } finally {
                promise.resolve(null);
            }
        });
    }

    /**
     * JS has already checked the strings, the severity range and the labels.
     * {@code severity} 0 and a null label list are the SDK default. A throw
     * from the SDK must not escape a void method.
     */
    @Override
    public void upload(
            final String summary,
            final String description,
            final double severity,
            @Nullable final ReadableArray labels
    ) {
        try {
            Bugsee.upload(
                    summary,
                    description,
                    ReportArgs.severity((int) severity),
                    ReportArgs.labels(labels == null ? null : labels.toArrayList()));
        } catch (final RuntimeException e) {
            Log.e(TAG, "upload failed: " + e.getClass().getName());
        }
    }

    /**
     * On the UI thread: the dialog presents from there. Same argument
     * mapping as {@link #upload}. Does nothing before launch -- the SDK
     * logs and returns. The dialog runs {@code onBeforeReportCreated}
     * before it opens.
     */
    @Override
    public void showReportDialog(
            @Nullable final String summary,
            @Nullable final String description,
            final double severity,
            @Nullable final ReadableArray labels
    ) {
        try {
            final IssueSeverity sev = ReportArgs.severity((int) severity);
            final ArrayList<String> labelList =
                    ReportArgs.labels(labels == null ? null : labels.toArrayList());
            UiThreadUtil.runOnUiThread(() -> {
                try {
                    Bugsee.showReportDialog(summary, description, sev, labelList);
                } catch (final RuntimeException e) {
                    Log.e(TAG, "showReportDialog failed: " + e.getClass().getName());
                }
            });
        } catch (final RuntimeException e) {
            Log.e(TAG, "showReportDialog failed: " + e.getClass().getName());
        }
    }

    /**
     * One JS line into the wrapper channel. JS has already range-checked the
     * level; the holder defends again, maps it by value, and keeps a throwing
     * app filter from escaping onto this thread. Filtered natively only --
     * JS never runs the app's filter on these lines.
     */
    @Override
    public void wrapperLog(final String message, final double level) {
        WrapperChannelHolder.shared().log(message, (int) level);
    }

    /**
     * Arms the logcat drop for one console echo. Does not record a line.
     * {@code Bugsee.log} does not call this, so it does not arm a drop.
     *
     * <p>Returns {@code true}. The return keeps the call on the JS thread:
     * codegen queues a {@code void} method onto the native modules thread,
     * and the SDK's logcat reader could then filter the echo before this
     * credit existed. The console hook calls this before it writes the line.
     */
    @Override
    public boolean noteConsoleEcho(final String message) {
        LogFilterBridge.shared().noteEcho(message);
        return true;
    }

    @Override
    public void onNetworkFilterRequest(@NonNull final String requestId, @NonNull final String eventJson) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("requestId", requestId);
        payload.putString("eventJson", eventJson);
        emitOnNetworkFilterRequest(payload);
    }

    @Override
    public void setNetworkFilterEnabled(final boolean enabled) {
        NetworkFilterBridge.shared().setEnabled(enabled);
    }

    @Override
    public void replyNetworkFilter(final String requestId, @Nullable final String eventJson) {
        if (requestId == null) {
            return;
        }
        NetworkFilterBridge.shared().reply(requestId, eventJson);
    }

    /**
     * A network event the app recorded itself. The bridge stamps it with
     * {@code BugseeExchangeFactory.currentTimestamp()}, the SDK capture
     * clock, then builds the event and submits it with filtering required.
     * A missing factory or a null event is logged and dropped. That clock
     * is not read when the factory is missing: {@code NetworkEvents.record}
     * returns {@code NO_EVENT} before {@code clock.now()}. There is no
     * timeout that would pass the original through.
     */
    @Override
    public void addNetworkEvent(final String eventJson) {
        final NetworkEvents.Outcome outcome;
        try {
            final com.bugsee.library.contracts.exchange.BugseeExchangeFactory factory =
                    Bugsee.getExchangeFactory();
            // A null receiver makes factory::currentTimestamp throw while the
            // reference is created. record() never reads the clock in that
            // case, so the stand-in is not the factory clock.
            final NetworkEvents.Clock clock = factory == null ? () -> 0L : factory::currentTimestamp;
            outcome = NetworkEvents.record(
                    eventJson,
                    factory == null ? null : (timestamp, stage, eventId, mechanism, method) ->
                            factory.createNetworkEvent(timestamp, stage, eventId, mechanism, method),
                    (event, requiresFiltering) -> Bugsee.addNetworkEvent(event, requiresFiltering),
                    clock
            );
        } catch (final Throwable e) {
            Log.w(TAG, "addNetworkEvent dropped: the SDK made no event");
            return;
        }
        if (outcome == NetworkEvents.Outcome.NO_EVENT) {
            Log.w(TAG, "addNetworkEvent dropped: the SDK made no event");
        }
    }

    // --- Attributes and identity ---------------------------------------
    // Everything that decides a value's shape lives in AttributeBridge, which
    // is plain Java and unit-tested; this is only the translation to and from
    // the bridge's Promise/WritableMap shapes, and the SDK adapter.

    /** The one {@link AttributeBridge.Sdk} adapter; the class itself has no state. */
    private static final AttributeBridge.Sdk ATTRIBUTE_SDK = new AttributeBridge.Sdk() {
        @Override
        public void set(final String name, final Serializable value) {
            Bugsee.setAttribute(name, value);
        }

        @Override
        public Object getInMemory(final String name) {
            return Bugsee.getAttribute(name);
        }

        @Override
        public Map<String, Serializable> getPersisted() {
            return Bugsee.getAllAttributes();
        }
    };

    @Override
    public void setAttributeString(final String name, final String value, final Promise promise) {
        setAttribute(name, value, promise);
    }

    @Override
    public void setAttributeNumber(final String name, final double value, final Promise promise) {
        setAttribute(name, AttributeBridge.numberValue(value), promise);
    }

    @Override
    public void setAttributeBoolean(final String name, final boolean value, final Promise promise) {
        setAttribute(name, value, promise);
    }

    /**
     * {@code setAttribute*}'s shared body: verify, then resolve or reject.
     * Neither SDK's own {@code setAttribute} reports a dropped value
     * truthfully, so {@link AttributeBridge#setAndVerify}'s read-back is the
     * only honest signal (design doc, Phase 5).
     */
    private static void setAttribute(final String name, final Serializable value, final Promise promise) {
        try {
            if (AttributeBridge.setAndVerify(ATTRIBUTE_SDK, name, value)) {
                promise.resolve(null);
            } else {
                promise.reject(E_ATTRIBUTE_REJECTED,
                        "attribute \"" + name + "\" was not kept by the SDK");
            }
        } catch (final RuntimeException e) {
            rejectAttributeFailure(promise, "setAttribute", e);
        }
    }

    /**
     * Rejects {@code E_ATTRIBUTE_REJECTED} after an attribute or identity
     * operation throws. The message names the operation only
     * ({@link AttributeBridge#failureMessage}); the exception's message can
     * echo the attribute name or value that made the SDK throw, so only its
     * class name is logged.
     */
    private static void rejectAttributeFailure(
            final Promise promise, final String operation, final RuntimeException e) {
        Log.e(TAG, operation + " failed: " + e.getClass().getName());
        promise.reject(E_ATTRIBUTE_REJECTED, AttributeBridge.failureMessage(operation));
    }

    @Override
    public void getAttribute(final String name, final Promise promise) {
        try {
            promise.resolve(attributeValueMap(AttributeBridge.readOne(ATTRIBUTE_SDK, name)));
        } catch (final RuntimeException e) {
            rejectAttributeFailure(promise, "getAttribute", e);
        }
    }

    @Override
    public void getAllAttributes(final Promise promise) {
        try {
            final Map<String, Object> readable = AttributeBridge.readable(Bugsee.getAllAttributes());
            final WritableMap result = Arguments.createMap();
            for (final Map.Entry<String, Object> entry : readable.entrySet()) {
                putAttributeValue(result, entry.getKey(), entry.getValue());
            }
            promise.resolve(result);
        } catch (final RuntimeException e) {
            rejectAttributeFailure(promise, "getAllAttributes", e);
        }
    }

    @Override
    public void clearAttribute(final String name, final Promise promise) {
        try {
            Bugsee.clearAttribute(name);
            promise.resolve(null);
        } catch (final RuntimeException e) {
            rejectAttributeFailure(promise, "clearAttribute", e);
        }
    }

    @Override
    public void clearAllAttributes(final Promise promise) {
        try {
            Bugsee.clearAllAttributes();
            promise.resolve(null);
        } catch (final RuntimeException e) {
            rejectAttributeFailure(promise, "clearAllAttributes", e);
        }
    }

    @Override
    public void setUserIdentifier(final String identifier) {
        Bugsee.setUserIdentifier(identifier);
    }

    @Override
    public void getUserIdentifier(final Promise promise) {
        try {
            final String id = AttributeBridge.identifier(Bugsee.getUserIdentifier());
            final WritableMap result = Arguments.createMap();
            if (id != null) {
                result.putString("value", id);
            }
            promise.resolve(result);
        } catch (final RuntimeException e) {
            rejectAttributeFailure(promise, "getUserIdentifier", e);
        }
    }

    @Override
    public void clearUserIdentifier() {
        Bugsee.clearUserIdentifier();
    }

    @Override
    public void onLogFilterRequest(@NonNull final String requestId, @NonNull final String line) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("requestId", requestId);
        payload.putString("line", line);
        emitOnLogFilterRequest(payload);
    }

    @Override
    public void setLogFilterEnabled(final boolean enabled) {
        LogFilterBridge.shared().setEnabled(enabled);
    }

    @Override
    public void replyLogFilter(final String requestId, @Nullable final String line) {
        if (requestId == null) {
            return;
        }
        LogFilterBridge.shared().reply(requestId, line);
    }

    @Override
    public void onBreadcrumbFilterRequest(
            @NonNull final String requestId,
            @NonNull final String crumbJson,
            @Nullable final String addId
    ) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("requestId", requestId);
        payload.putString("crumbJson", crumbJson);
        if (addId != null) {
            payload.putString("addId", addId);
        }
        emitOnBreadcrumbFilterRequest(payload);
    }

    @Override
    public void setBreadcrumbFilterEnabled(final boolean enabled) {
        BreadcrumbFilterBridge.shared().setEnabled(enabled);
    }

    @Override
    public void replyBreadcrumbFilter(
            final String requestId,
            @Nullable final String crumbJson
    ) {
        if (requestId == null) {
            return;
        }
        BreadcrumbFilterBridge.shared().reply(requestId, crumbJson);
    }

    /**
     * Builds the crumb with {@link Bugsee#getExchangeFactory()} and records
     * it. The no-argument {@code createBreadcrumb} leaves the timestamp unset
     * so the provider stamps it. {@code level} is the JS name;
     * {@link BreadcrumbFilterBridge#levelFromName} maps it to
     * {@link Breadcrumb.Level}. {@code dataJson} null leaves data unset.
     *
     * <p>Returns true only when a filter request for {@code addId} was
     * emitted during {@link Bugsee#addBreadcrumb}. The filter runs before
     * that call returns, so the id has to be visible to it for this call
     * only. False means JS should drop the id.
     */
    @Override
    public boolean addBreadcrumb(
            final String category,
            final String level,
            final String message,
            final String type,
            @Nullable final String dataJson,
            @Nullable final String addId
    ) {
        try {
            // iOS still hands back a crumb when this option is false, then
            // records nothing. Android's factory is null in that case. Either
            // way the call has to say so.
            final OptionsContainer options = Bugsee.getLaunchOptions();
            final Object capture = options == null
                    ? Boolean.FALSE
                    : options.getOption(Options.CaptureBreadcrumbs, Boolean.FALSE);
            if (!Boolean.TRUE.equals(capture)) {
                Log.e(TAG, "addBreadcrumb dropped: capture is off or the SDK made no crumb");
                return false;
            }
            final BugseeExchangeFactory factory = Bugsee.getExchangeFactory();
            if (factory == null) {
                Log.e(TAG, "addBreadcrumb dropped: capture is off or the SDK made no crumb");
                return false;
            }
            final Breadcrumb crumb = factory.createBreadcrumb();
            if (crumb == null) {
                Log.e(TAG, "addBreadcrumb dropped: capture is off or the SDK made no crumb");
                return false;
            }
            final Breadcrumb.Level parsed = BreadcrumbFilterBridge.levelFromName(level);
            if (parsed == null) {
                Log.e(TAG, "addBreadcrumb dropped: level is not a breadcrumb level name");
                return false;
            }
            crumb.setCategory(category);
            crumb.setLevel(parsed);
            crumb.setMessage(message);
            crumb.setType(type);
            if (dataJson != null) {
                crumb.setData(BridgeJson.parseObject(dataJson));
            }
            final boolean[] emitted = { false };
            BreadcrumbFilterBridge.shared().withSdkLock(() -> {
                if (addId != null) {
                    BreadcrumbFilterBridge.shared().beginManualAdd(addId);
                }
                try {
                    Bugsee.addBreadcrumb(crumb);
                    emitted[0] = addId != null
                            && BreadcrumbFilterBridge.shared().takeUnclaimedManualAdd() == null;
                } finally {
                    BreadcrumbFilterBridge.shared().takeUnclaimedManualAdd();
                }
            });
            return emitted[0];
        } catch (final BridgeJson.BadJson e) {
            Log.e(TAG, "addBreadcrumb dropped: its data is not a JSON object: " + e.getMessage());
            return false;
        } catch (final RuntimeException e) {
            Log.e(TAG, "addBreadcrumb failed: " + e.getClass().getName());
            return false;
        }
    }

    /** {@code { value }}, typed by {@code value}'s runtime type, or empty when absent. */
    private static WritableMap attributeValueMap(@Nullable final Object value) {
        final WritableMap result = Arguments.createMap();
        putAttributeValue(result, "value", value);
        return result;
    }

    /**
     * Writes one attribute value into {@code target}, typed as
     * {@link AttributeBridge#readable} produced it: {@code String}, {@code
     * Boolean}, {@code Number} (always a {@code Double} -- see {@link
     * AttributeBridge#readable}) or a {@code List<String>}. Absent ({@code
     * null}) writes nothing, leaving the key out entirely.
     */
    private static void putAttributeValue(
            @NonNull final WritableMap target,
            @NonNull final String key,
            @Nullable final Object value
    ) {
        if (value instanceof String) {
            target.putString(key, (String) value);
        } else if (value instanceof Boolean) {
            target.putBoolean(key, (Boolean) value);
        } else if (value instanceof Number) {
            target.putDouble(key, ((Number) value).doubleValue());
        } else if (value instanceof List) {
            target.putArray(key, toWritableArray((List<?>) value));
        }
    }

    /**
     * Records a named event, with optional params.
     *
     * {@code paramsJson} is the params as JSON text ({@code src/bridge/json.ts}),
     * parsed by {@link BridgeJson} -- the one transport for object payloads,
     * because iOS's object-argument conversion drops null members and this
     * one must mean the same thing on both platforms. Text that does not parse
     * drops the event, logged: a void method has no promise to reject.
     *
     * {@code null} params calls the SDK's one-argument overload rather than
     * passing an empty map: the bundle's event entry has no {@code params}
     * key at all when none were given (design doc, Phase 4 bundle facts), and
     * a {@code {}} here would produce one. JS has already validated params
     * against the accepted value domain and copied it
     * ({@code src/data/validate.ts}), so nothing here is re-checked -- only
     * guarded, since a void TurboModule method has no promise to reject and
     * an escaping exception crashes the host app.
     */
    @Override
    public void event(final String name, @Nullable final String paramsJson) {
        try {
            if (paramsJson == null) {
                Bugsee.event(name);
            } else {
                Bugsee.event(name, BridgeJson.parseObject(paramsJson));
            }
        } catch (final BridgeJson.BadJson e) {
            Log.e(TAG, "event \"" + name + "\" dropped: its params are not a JSON object: "
                    + e.getMessage());
        } catch (RuntimeException e) {
            Log.e(TAG, "event failed: " + e.getClass().getName());
        }
    }

    /** A numeric trace value. Boxed to a {@code Double}, the SDK's own {@code Object} overload. */
    @Override
    public void traceNumber(final String name, final double value) {
        try {
            Bugsee.trace(name, value);
        } catch (RuntimeException e) {
            Log.e(TAG, "traceNumber failed: " + e.getClass().getName());
        }
    }

    /** A string trace value. */
    @Override
    public void traceString(final String name, final String value) {
        try {
            Bugsee.trace(name, value);
        } catch (RuntimeException e) {
            Log.e(TAG, "traceString failed: " + e.getClass().getName());
        }
    }

    /**
     * A boolean trace value, boxed explicitly to a {@code Boolean} -- kept
     * apart from {@link #traceNumber} so it cannot silently arrive as
     * {@code 0}/{@code 1} on the SDK side.
     */
    @Override
    public void traceBoolean(final String name, final boolean value) {
        try {
            Bugsee.trace(name, Boolean.valueOf(value));
        } catch (RuntimeException e) {
            Log.e(TAG, "traceBoolean failed: " + e.getClass().getName());
        }
    }

    @Override
    public void onReportHandlerRequest(
            @NonNull final String handleId,
            @NonNull final String phase,
            @NonNull final String reportId,
            @NonNull final String type,
            final double deadlineMs
    ) {
        final WritableMap payload = Arguments.createMap();
        payload.putString("handleId", handleId);
        payload.putString("phase", phase);
        payload.putString("reportId", reportId);
        payload.putString("type", type);
        payload.putDouble("deadlineMs", deadlineMs);
        emitOnReportHandlerRequest(payload);
    }

    @Override
    public void setReportHandlerPhases(final boolean before, final boolean after) {
        ReportHandlerBridge.shared().setPhases(before, after);
    }

    @Override
    public void completeReportHandler(final String handleId) {
        ReportHandlerBridge.shared().complete(handleId);
    }

    // The report ops run on the calling (native-modules) thread: the SDK
    // documents Report as usable from any thread, and its collections are
    // synchronized. Each catches everything -- an exception escaping a
    // TurboModule method is a crash in a release build, and the SDK's fault
    // is not worth the app.

    @Override
    public void reportRead(final String handleId, final Promise promise) {
        final Report report = ReportHandlerBridge.shared().reportFor(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            promise.resolve(snapshotToWritableMap(ReportOps.read(report)));
        } catch (final Throwable e) {
            rejectReportFailure(promise, "reportRead", e);
        }
    }

    @Override
    public void reportUpdate(final String handleId, final String patchJson, final Promise promise) {
        final Report report = ReportHandlerBridge.shared().reportFor(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            // JSON text, not a ReadableMap: the transport iOS needs to keep a
            // clearing null, used here too so both platforms parse one form.
            ReportOps.applyJson(report, patchJson);
            promise.resolve(null);
        } catch (final ReportOps.BadArgument e) {
            promise.reject(E_REPORT_BAD_ARGUMENT, e.getMessage());
        } catch (final Throwable e) {
            rejectReportFailure(promise, "reportUpdate", e);
        }
    }

    @Override
    public void reportAddFileAttachment(
            final String handleId,
            final String path,
            final String name,
            @Nullable final String mimeType,
            final boolean move,
            final Promise promise
    ) {
        final Report report = ReportHandlerBridge.shared().reportFor(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            settleAttachment(handleId, ReportOps.addFile(report, path, name, mimeType, move), promise);
        } catch (final Throwable e) {
            rejectReportFailure(promise, "reportAddFileAttachment", e);
        }
    }

    @Override
    public void reportAddDataAttachment(
            final String handleId,
            final String base64,
            final String name,
            @Nullable final String mimeType,
            final Promise promise
    ) {
        final Report report = ReportHandlerBridge.shared().reportFor(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        final byte[] data;
        try {
            data = Base64.decode(base64, Base64.NO_WRAP);
        } catch (final IllegalArgumentException e) {
            promise.reject(E_REPORT_BAD_ARGUMENT, "data must be base64-encoded");
            return;
        }
        try {
            settleAttachment(handleId, ReportOps.addData(report, data, name, mimeType), promise);
        } catch (final Throwable e) {
            rejectReportFailure(promise, "reportAddDataAttachment", e);
        }
    }

    /**
     * One created report at a time. The slot is reserved before the SDK is
     * asked, because {@code onCreated} arrives later, on the main thread.
     * A throw from that call ends the reservation; otherwise the listener does,
     * with {@code cr-<n>} or null.
     */
    @Override
    public void createReport(final Promise promise) {
        final CreatedReports registry = CreatedReports.shared();
        final int stamp = registry.tryReserve();
        if (stamp == 0) {
            Log.i(TAG, "created report - busy");
            promise.reject(
                    E_REPORT_CREATE_BUSY,
                    "A created report is already outstanding.");
            return;
        }
        try {
            Bugsee.createReport(created -> deliverCreatedReport(registry, stamp, created, promise));
        } catch (final Throwable thrown) {
            // The SDK threw before the listener ran. The stamp no-ops once
            // this reservation has been cleared and another one opened.
            registry.fulfil(stamp, null);
            rejectReportFailure(promise, "createReport", thrown);
        }
    }

    /**
     * Runs on the SDK's listener thread. A throw here would escape onto that
     * thread, so it is caught, the reservation is ended, and the promise rejects.
     * The stamp is the one captured at reserve time: a listener that arrives
     * after {@code invalidate} cleared that reservation cannot end a newer one.
     */
    private static void deliverCreatedReport(
            final CreatedReports registry,
            final int stamp,
            @Nullable final Report created,
            final Promise promise
    ) {
        String handle = null;
        try {
            handle = registry.fulfil(stamp, created);
            if (handle == null) {
                Log.i(TAG, "created report - none");
            } else {
                Log.i(TAG, "created report " + handle + " created");
            }
            promise.resolve(handle);
        } catch (final Throwable thrown) {
            if (handle != null) {
                registry.take(handle);
            } else {
                registry.fulfil(stamp, null);
            }
            rejectReportFailure(promise, "createReport", thrown);
        }
    }

    @Override
    public void createdReportRead(final String handleId, final Promise promise) {
        final Report report = CreatedReports.shared().get(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            promise.resolve(snapshotToWritableMap(ReportOps.read(report)));
        } catch (final Throwable e) {
            rejectReportFailure(promise, "createdReportRead", e);
        }
    }

    @Override
    public void createdReportUpdate(
            final String handleId,
            final String patchJson,
            final Promise promise
    ) {
        final Report report = CreatedReports.shared().get(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            ReportOps.applyJson(report, patchJson);
            promise.resolve(null);
        } catch (final ReportOps.BadArgument e) {
            promise.reject(E_REPORT_BAD_ARGUMENT, e.getMessage());
        } catch (final Throwable e) {
            rejectReportFailure(promise, "createdReportUpdate", e);
        }
    }

    @Override
    public void createdReportAddDataAttachment(
            final String handleId,
            final String base64,
            final String name,
            @Nullable final String mimeType,
            final Promise promise
    ) {
        final Report report = CreatedReports.shared().get(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        final byte[] data;
        try {
            data = Base64.decode(base64, Base64.NO_WRAP);
        } catch (final IllegalArgumentException e) {
            promise.reject(E_REPORT_BAD_ARGUMENT, "data must be base64-encoded");
            return;
        }
        try {
            settleCreatedAttachment(
                    handleId, ReportOps.addData(report, data, name, mimeType), promise);
        } catch (final Throwable e) {
            rejectReportFailure(promise, "createdReportAddDataAttachment", e);
        }
    }

    /** Copied, not moved: a created report has no {@code move} argument. */
    @Override
    public void createdReportAddFileAttachment(
            final String handleId,
            final String path,
            final String name,
            @Nullable final String mimeType,
            final Promise promise
    ) {
        final Report report = CreatedReports.shared().get(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            settleCreatedAttachment(
                    handleId,
                    ReportOps.addFile(report, path, name, mimeType, false),
                    promise);
        } catch (final Throwable e) {
            rejectReportFailure(promise, "createdReportAddFileAttachment", e);
        }
    }

    /**
     * Takes the report first, so the slot is free whether or not the upload
     * succeeds. The handle is dead afterwards.
     */
    @Override
    public void createdReportUpload(final String handleId, final Promise promise) {
        final Report report = CreatedReports.shared().take(handleId);
        if (report == null) {
            rejectHandleDead(promise);
            return;
        }
        try {
            Bugsee.upload(report, ok -> {
                try {
                    Log.i(TAG, "created report " + handleId + " uploaded ok=" + ok);
                    promise.resolve(ok);
                } catch (final Throwable thrown) {
                    rejectReportFailure(promise, "createdReportUpload", thrown);
                }
            });
        } catch (final Throwable thrown) {
            rejectReportFailure(promise, "createdReportUpload", thrown);
        }
    }

    /**
     * Rejects after a report operation faults with anything it does not
     * validate itself. The code stays React Native's own default
     * ({@code EUNSPECIFIED}, what {@code reject(Throwable)} produced): an
     * unexpected fault is not one of the codes the JS contract names. The
     * message names the operation only ({@link ReportOps#failureMessage}) --
     * the fault's own message can echo report content (a summary, an
     * attribute value, a file path, an attachment name), and passing the
     * Throwable would also send its message and stack to JS. Only its class
     * name is logged.
     */
    private static void rejectReportFailure(
            final Promise promise, final String operation, final Throwable e) {
        Log.e(TAG, operation + " failed: " + e.getClass().getName());
        promise.reject((String) null, ReportOps.failureMessage(operation));
    }

    /**
     * The SDK returns null both for a declined attachment and for a report
     * that is no longer live. The handle tells the two apart: if it died while
     * the call ran, that is the truer answer.
     */
    private static void settleAttachment(
            final String handleId,
            final boolean added,
            final Promise promise
    ) {
        if (added) {
            promise.resolve(null);
        } else if (ReportHandlerBridge.shared().reportFor(handleId) == null) {
            rejectHandleDead(promise);
        } else {
            promise.reject(E_REPORT_ATTACHMENT_REJECTED, "The SDK declined the attachment");
        }
    }

    /** Same decision as {@link #settleAttachment}, against the created-report registry. */
    private static void settleCreatedAttachment(
            final String handleId,
            final boolean added,
            final Promise promise
    ) {
        if (added) {
            promise.resolve(null);
        } else if (CreatedReports.shared().get(handleId) == null) {
            rejectHandleDead(promise);
        } else {
            promise.reject(E_REPORT_ATTACHMENT_REJECTED, "The SDK declined the attachment");
        }
    }

    private static void rejectHandleDead(final Promise promise) {
        promise.reject(
                E_REPORT_HANDLE_DEAD,
                "This BugseeReport handle is no longer valid: its handler has "
                        + "already settled, or its deadline has passed.");
    }

    /** {@link ReportOps#read}'s snapshot as a bridge map. */
    private static WritableMap snapshotToWritableMap(@NonNull final Map<String, Object> snapshot) {
        final WritableMap result = Arguments.createMap();
        for (final Map.Entry<String, Object> entry : snapshot.entrySet()) {
            final String key = entry.getKey();
            final Object value = entry.getValue();
            if (value == null) {
                result.putNull(key);
            } else if (value instanceof Boolean) {
                result.putBoolean(key, (Boolean) value);
            } else if (value instanceof Number) {
                result.putDouble(key, ((Number) value).doubleValue());
            } else if (value instanceof String) {
                result.putString(key, (String) value);
            } else if (value instanceof Map) {
                @SuppressWarnings("unchecked")
                final Map<String, Object> nested = (Map<String, Object>) value;
                result.putMap(key, snapshotToWritableMap(nested));
            } else if (value instanceof List) {
                result.putArray(key, toWritableArray((List<?>) value));
            }
        }
        return result;
    }

    private static WritableArray toWritableArray(@NonNull final List<?> list) {
        final WritableArray result = Arguments.createArray();
        for (final Object value : list) {
            if (value instanceof Boolean) {
                result.pushBoolean((Boolean) value);
            } else if (value instanceof Number) {
                result.pushDouble(((Number) value).doubleValue());
            } else if (value instanceof String) {
                result.pushString((String) value);
            } else {
                result.pushNull();
            }
        }
        return result;
    }

    /** Turns the SDK's option map into something the bridge can return. */
    private static WritableMap toWritableMap(@Nullable final Map<String, Serializable> options) {
        final WritableMap result = Arguments.createMap();
        if (options == null) {
            return result;
        }
        for (final Map.Entry<String, Serializable> entry : options.entrySet()) {
            final Serializable value = entry.getValue();
            if (value instanceof Boolean) {
                result.putBoolean(entry.getKey(), (Boolean) value);
            } else if (value instanceof Number) {
                result.putDouble(entry.getKey(), ((Number) value).doubleValue());
            } else if (value instanceof String) {
                result.putString(entry.getKey(), (String) value);
            } else if (value instanceof Enum) {
                // Enums go back as the number they arrived as -- their
                // internal value, which is what both platforms speak.
                result.putDouble(entry.getKey(), BugseeOptionEnums.wireValue(value));
            }
            // Anything else has no JS representation; omitted rather than
            // stringified, which would read as a value the app could set back.
        }
        return result;
    }

    /**
     * Flattens the JS options map into what the SDK takes.
     *
     * <p>An unrecognised value is dropped rather than guessed at: a wrong
     * coercion would look like the option was honoured. Numbers go through
     * {@link BugseeOptionEnums}, because an enum-typed option arriving as a
     * bare number is ignored by the SDK's Map path.
     */
    private static Map<String, Serializable> toOptions(@Nullable final ReadableMap options) {
        final Map<String, Serializable> result = new HashMap<>();
        if (options == null) {
            return result;
        }
        final ReadableMapKeySetIterator keys = options.keySetIterator();
        while (keys.hasNextKey()) {
            final String key = keys.nextKey();
            switch (options.getType(key)) {
                case Boolean:
                    result.put(key, options.getBoolean(key));
                    break;
                case Number:
                    // Enum-typed keys arrive as their internal value and must
                    // become enum instances: the SDK's Map path does not
                    // coerce, so a bare number is ignored. null means the
                    // value names no constant, and the option is dropped
                    // rather than guessed at.
                    final Serializable number =
                            BugseeOptionEnums.numberFor(key, options.getDouble(key));
                    if (number != null) {
                        result.put(key, number);
                    }
                    break;
                case String:
                    result.put(key, options.getString(key));
                    break;
                default:
                    break;
            }
        }
        return result;
    }

    // --- Notify and spans ------------------------------------------------
    // Span calls stay on this thread. Both SDKs keep the active span in
    // thread-local storage, so hopping to another thread would make
    // startSpan miss the transaction startTransaction just opened.
    // The setters return a boolean for that same thread: codegen queues a
    // void TurboModule method, and a setAttribute then finish in one turn
    // would release the handle before the setter ran.

    @Override
    public void notify(
            final String title,
            @Nullable final String body,
            final double severity,
            @Nullable final String fieldsJson,
            final boolean urgent
    ) {
        Map<String, String> fields = null;
        if (fieldsJson != null) {
            try {
                final Map<String, Object> parsed = BridgeJson.parseObject(fieldsJson);
                fields = new LinkedHashMap<>();
                for (final Map.Entry<String, Object> entry : parsed.entrySet()) {
                    if (entry.getValue() instanceof String) {
                        fields.put(entry.getKey(), (String) entry.getValue());
                    }
                }
            } catch (final BridgeJson.BadJson error) {
                Log.w(TAG, "notify dropped: " + error.getMessage());
                return;
            }
        }
        Bugsee.notify(title, body, ReportArgs.severity((int) severity), fields, urgent);
    }

    @Override
    public WritableMap startTransaction(
            final String name,
            final String operation,
            @Nullable final String attributesJson
    ) {
        final Map<String, Object> attributes = attributes(attributesJson, "startTransaction");
        final Transaction transaction = attributes == null
                ? Bugsee.startTransaction(name, operation)
                : Bugsee.startTransaction(name, operation, attributes);
        if (transaction == null) {
            return noSpan();
        }
        return snapshot(spanHandles.retain(transaction, new LiveSpan(transaction)), transaction);
    }

    @Override
    public WritableMap startSpan(final String operation, @Nullable final String description) {
        final Span span = Bugsee.startSpan(operation, description);
        if (span == null) {
            return noSpan();
        }
        return snapshot(spanHandles.retain(span, new LiveSpan(span)), span);
    }

    @Override
    public WritableMap getActiveSpan() {
        final Span span = Bugsee.getActiveSpan();
        if (span == null) {
            return noSpan();
        }
        return snapshot(spanHandles.retain(span, new LiveSpan(span)), span);
    }

    @Override
    public boolean spanSetName(final String handle, final String name) {
        final LiveSpan live = live(handle);
        if (live == null) {
            return false;
        }
        live.span.setName(name);
        return true;
    }

    @Override
    public boolean spanSetDescription(final String handle, @Nullable final String description) {
        final LiveSpan live = live(handle);
        if (live == null) {
            return false;
        }
        live.span.setDescription(description);
        return true;
    }

    @Override
    public boolean spanSetAttribute(final String handle, final String key, final String valueJson) {
        final LiveSpan live = live(handle);
        if (live == null) {
            return false;
        }
        final Object value = jsonValue(valueJson);
        if (value == null) {
            Log.w(TAG, "span attribute dropped: value is not a string, number or boolean");
            return false;
        }
        live.span.setAttribute(key, value);
        return true;
    }

    @Override
    public boolean spanSetStatus(final String handle, final double status) {
        final LiveSpan live = live(handle);
        final SpanStatus parsed = SpanHandles.status((int) status);
        if (live == null || parsed == null) {
            if (parsed == null) {
                Log.w(TAG, "span status is outside 0..5");
            }
            return false;
        }
        live.span.setStatus(parsed);
        return true;
    }

    @Override
    public WritableMap spanStartChild(
            final String handle,
            final String operation,
            @Nullable final String description
    ) {
        final LiveSpan live = live(handle);
        if (live == null) {
            return noSpan();
        }
        final Span child = description == null
                ? live.span.startChildSpan(operation)
                : live.span.startChildSpan(operation, description);
        if (child == null) {
            return noSpan();
        }
        return snapshot(spanHandles.retain(child, new LiveSpan(child)), child);
    }

    @Override
    public WritableArray spanFinish(final String handle, final double status, final boolean statusSet) {
        final WritableArray released = Arguments.createArray();
        final SpanStatus parsed = statusSet ? SpanHandles.status((int) status) : null;
        if (statusSet && parsed == null) {
            Log.w(TAG, "span finish status is outside 0..5");
            return released;
        }
        for (final String id : spanHandles.finish(handle, parsed)) {
            released.pushString(id);
        }
        return released;
    }

    @Nullable
    private LiveSpan live(final String handle) {
        final SpanHandles.Retained retained = spanHandles.get(handle);
        if (retained instanceof LiveSpan) {
            return (LiveSpan) retained;
        }
        return null;
    }

    private static WritableMap noSpan() {
        final WritableMap map = Arguments.createMap();
        map.putString("handle", "");
        return map;
    }

    private static WritableMap snapshot(final String handle, final Span span) {
        final WritableMap map = Arguments.createMap();
        map.putString("handle", handle);
        map.putString("spanId", span.getSpanId() == null ? "" : span.getSpanId());
        map.putString("traceId", span.getTraceId() == null ? "" : span.getTraceId());
        map.putString("operation", span.getOperation() == null ? "" : span.getOperation());
        if (span.getDescription() == null) {
            map.putNull("description");
        } else {
            map.putString("description", span.getDescription());
        }
        final SpanStatus status = span.getStatus();
        map.putInt("status", status == null ? 0 : status.ordinal());
        map.putBoolean("finished", span.isFinished());
        map.putString("attributesJson", attributesJson(span.getAttributes()));
        if (span instanceof Transaction) {
            final Transaction transaction = (Transaction) span;
            map.putString("name", transaction.getName() == null ? "" : transaction.getName());
            map.putBoolean("sampled", transaction.isSampled());
        }
        return map;
    }

    private static String attributesJson(@Nullable final Map<String, Object> attributes) {
        if (attributes == null || attributes.isEmpty()) {
            return "{}";
        }
        final JSONObject object = new JSONObject();
        for (final Map.Entry<String, Object> entry : attributes.entrySet()) {
            final Object value = entry.getValue();
            if (value instanceof String || value instanceof Boolean || value instanceof Number) {
                try {
                    object.put(entry.getKey(), value);
                } catch (final JSONException ignored) {
                    // A key the JSON writer refuses is omitted, not fatal.
                }
            }
        }
        return object.toString();
    }

    @Nullable
    private static Map<String, Object> attributes(
            @Nullable final String json,
            final String method
    ) {
        if (json == null) {
            return null;
        }
        try {
            return BridgeJson.parseObject(json);
        } catch (final BridgeJson.BadJson error) {
            Log.w(TAG, method + " dropped attributes: " + error.getMessage());
            return null;
        }
    }

    // --- Appearance and collected data (Phase 11) ---------------------------
    // set/get return a value so codegen runs them on the JS thread, ahead of
    // the read that follows a write in the same turn.

    @Override
    public boolean setAppearanceColor(
            final String name,
            final double r,
            final double g,
            final double b,
            final double a
    ) {
        AppearanceBridge.setColor(
                name,
                (int) Math.round(r),
                (int) Math.round(g),
                (int) Math.round(b),
                (int) Math.round(a)
        );
        return true;
    }

    @Override
    @NonNull
    public String getAppearanceColor(final String name) {
        return AppearanceBridge.toHex(AppearanceBridge.getColor(name));
    }

    @Override
    public void deleteCollectedDataOnDevice(
            final boolean includingIntermediate,
            final Promise promise
    ) {
        Bugsee.deleteCollectedDataOnDevice(
                includingIntermediate,
                success -> promise.resolve(Boolean.TRUE.equals(success))
        );
    }

    /** One JSON value, or null when it is missing, null, an object or an array. */
    @Nullable
    private static Object jsonValue(@Nullable final String json) {
        if (json == null) {
            return null;
        }
        final JSONTokener tokener = new JSONTokener(json);
        final Object value;
        try {
            value = tokener.nextValue();
        } catch (final JSONException error) {
            Log.w(TAG, "span attribute dropped: malformed JSON (" + json.length() + " characters)");
            return null;
        }
        if (value == null || value == JSONObject.NULL) {
            return null;
        }
        if (value instanceof String || value instanceof Boolean) {
            return value;
        }
        if (value instanceof Integer || value instanceof Long) {
            return value;
        }
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        return null;
    }

    /** The SDK span plus the registry's finish/isFinished surface. */
    private static final class LiveSpan implements SpanHandles.Retained {
        final Span span;

        LiveSpan(final Span span) {
            this.span = span;
        }

        @Override
        public void finish(@Nullable final SpanStatus status) {
            if (status == null) {
                span.finish();
            } else {
                span.finish(status);
            }
        }

        @Override
        public boolean isFinished() {
            return span.isFinished();
        }
    }
}
