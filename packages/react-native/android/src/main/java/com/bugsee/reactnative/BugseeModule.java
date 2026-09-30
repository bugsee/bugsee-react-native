package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Base64;
import android.util.Log;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.reporting.Report;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The Android half of the `Bugsee` TurboModule.
 *
 * <p>Thin on purpose. Everything that translates between the JS wire shape and
 * the SDK's types lives in {@link BugseeTokens}, {@link BugseeStatusMapper},
 * {@link ReportOps} and {@link ReportHandlerBridge}, which are plain Java and
 * unit-tested without React Native or a device; what is left here is the part
 * that can only be exercised by running the app, and is covered by the example
 * app's e2e instead.
 */
@ReactModule(name = BugseeModule.NAME)
public class BugseeModule extends NativeBugseeSpec
        implements WrapperEventBus.Sink, ReportHandlerBridge.Sink {

    public static final String NAME = "Bugsee";

    /** The wrapper's log tag, as ReportHandlerBridge and WrapperEventBus use. */
    private static final String TAG = "BugseeRN";

    // The stable codes of src/report/errors.ts. An app matches on these.
    private static final String E_REPORT_HANDLE_DEAD = "E_REPORT_HANDLE_DEAD";
    private static final String E_REPORT_ATTACHMENT_REJECTED = "E_REPORT_ATTACHMENT_REJECTED";
    private static final String E_REPORT_BAD_ARGUMENT = "E_REPORT_BAD_ARGUMENT";
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
        // Same for any outstanding vh request, and disables the view tree:
        // the next runtime's anchor has not mounted yet.
        DataRequestBridge.shared().detach(dataRequestSink);
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
                launched -> promise.resolve(Boolean.TRUE.equals(launched)));
    }

    @Override
    public void relaunch(final ReadableMap options, final Promise promise) {
        Bugsee.relaunch(toOptions(options), relaunched -> promise.resolve(Boolean.TRUE.equals(relaunched)));
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
            Log.e(TAG, "setSecureRectangles failed; the previous set stays published", e);
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

    // The two-argument overload only -- severity and labels are Phase 8. JS
    // has already checked both arguments are strings, so nothing is
    // re-validated here.
    @Override
    public void upload(final String summary, final String description) {
        Bugsee.upload(summary, description);
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
            promise.reject(E_ATTRIBUTE_REJECTED, e.getMessage());
        }
    }

    @Override
    public void getAttribute(final String name, final Promise promise) {
        try {
            promise.resolve(attributeValueMap(AttributeBridge.readOne(ATTRIBUTE_SDK, name)));
        } catch (final RuntimeException e) {
            promise.reject(E_ATTRIBUTE_REJECTED, e.getMessage());
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
            promise.reject(E_ATTRIBUTE_REJECTED, e.getMessage());
        }
    }

    @Override
    public void clearAttribute(final String name, final Promise promise) {
        try {
            Bugsee.clearAttribute(name);
            promise.resolve(null);
        } catch (final RuntimeException e) {
            promise.reject(E_ATTRIBUTE_REJECTED, e.getMessage());
        }
    }

    @Override
    public void clearAllAttributes(final Promise promise) {
        try {
            Bugsee.clearAllAttributes();
            promise.resolve(null);
        } catch (final RuntimeException e) {
            promise.reject(E_ATTRIBUTE_REJECTED, e.getMessage());
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
            promise.reject(E_ATTRIBUTE_REJECTED, e.getMessage());
        }
    }

    @Override
    public void clearUserIdentifier() {
        Bugsee.clearUserIdentifier();
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
            Log.e(TAG, "event failed", e);
        }
    }

    /** A numeric trace value. Boxed to a {@code Double}, the SDK's own {@code Object} overload. */
    @Override
    public void traceNumber(final String name, final double value) {
        try {
            Bugsee.trace(name, value);
        } catch (RuntimeException e) {
            Log.e(TAG, "traceNumber failed", e);
        }
    }

    /** A string trace value. */
    @Override
    public void traceString(final String name, final String value) {
        try {
            Bugsee.trace(name, value);
        } catch (RuntimeException e) {
            Log.e(TAG, "traceString failed", e);
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
            Log.e(TAG, "traceBoolean failed", e);
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
            promise.reject(e);
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
            promise.reject(e);
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
            promise.reject(e);
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
            promise.reject(e);
        }
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
}
