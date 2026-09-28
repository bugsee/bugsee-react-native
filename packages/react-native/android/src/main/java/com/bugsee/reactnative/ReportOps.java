package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.options.IssueSeverity;
import com.bugsee.library.contracts.options.IssueType;
import com.bugsee.library.contracts.reporting.Attachment;
import com.bugsee.library.contracts.reporting.Report;

import java.io.File;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code BugseeReport} operations, between the JS wire shape and the SDK's
 * {@link Report}. Plain Java, so every rule here is unit-tested.
 *
 * <p>The SDK documents {@code Report} as safe from any thread, and its
 * collections are synchronized, so these run on whatever thread the bridge
 * calls them from.
 */
final class ReportOps {

    /** A patch or argument the JS contract does not allow; nothing was applied. */
    static final class BadArgument extends Exception {
        BadArgument(@NonNull final String message) {
            super(message);
        }
    }

    /** JS numbers are doubles; beyond 2^53 a double is no longer an exact integer. */
    private static final double MAX_SAFE_INTEGER = 9_007_199_254_740_992.0;

    private ReportOps() {
    }

    /** {@code toString()}, the wire name ({@code "crash"}); {@code name()} is "Crash". */
    @NonNull
    static String typeOf(@NonNull final Report report) {
        final IssueType type = report.getType();
        return type == null ? "" : type.toString();
    }

    /**
     * The snapshot {@code reportRead} returns. Keys and shapes match
     * {@code BugseeReportSnapshot}; the JS side normalises anything missing.
     */
    @NonNull
    static Map<String, Object> read(@NonNull final Report report) {
        final Map<String, Object> result = new HashMap<>();
        result.put("summary", report.getSummary());
        result.put("description", report.getDescription());

        // By value, never ordinal(): Critical is ordinal 3 and value 4.
        final IssueSeverity severity = report.getSeverity();
        result.put("severity", severity == null ? null : severity.getValue());

        result.put("labels", new ArrayList<>(report.getLabels()));

        final Map<String, Object> attributes = new HashMap<>();
        for (final Map.Entry<String, Serializable> entry : report.getAttributes().entrySet()) {
            final Object value = entry.getValue();
            // The JS type is string | number | boolean; anything else has no
            // representation there, and a toString would read as a real value.
            if (value instanceof String || value instanceof Number || value instanceof Boolean) {
                attributes.put(entry.getKey(), value);
            }
        }
        result.put("attributes", attributes);

        // Sorted here because the SDK build this is pinned to may predate
        // bugsee-android#178, which sorts them at the source.
        final List<Integer> displayIds = new ArrayList<>();
        final List<Integer> sdkIds = report.getScreenshotDisplayIds();
        if (sdkIds != null) {
            for (final Integer id : sdkIds) {
                if (id != null) {
                    displayIds.add(id);
                }
            }
        }
        Collections.sort(displayIds);
        result.put("screenshotDisplayIds", displayIds);

        final List<String> attachmentNames = new ArrayList<>();
        for (final Attachment attachment : report.getAttachments()) {
            final String name = attachment == null ? null : attachment.getName();
            if (name != null) {
                attachmentNames.add(name);
            }
        }
        result.put("attachmentNames", attachmentNames);
        return result;
    }

    /**
     * Applies a {@code reportUpdate} patch: validates every field first, and
     * only then touches the report, so a rejected patch changes nothing.
     *
     * <p>The JS side has validated the same rules before crossing; this is not
     * a second opinion but the last line before the SDK, which would silently
     * coerce what it does not understand (severity 0 becomes {@code VeryLow}).
     */
    static void apply(@NonNull final Report report, @NonNull final Map<String, Object> patch)
            throws BadArgument {
        for (final String key : patch.keySet()) {
            switch (key) {
                case "summary":
                case "description":
                case "severity":
                case "labels":
                case "clearAttributes":
                case "attributes":
                    break;
                default:
                    throw new BadArgument("update() received an unknown key \"" + key + "\"");
            }
        }

        final boolean hasSummary = patch.containsKey("summary");
        final String summary = optionalString(patch, "summary");
        final boolean hasDescription = patch.containsKey("description");
        final String description = optionalString(patch, "description");
        final IssueSeverity severity = patch.containsKey("severity")
                ? severity(patch.get("severity"))
                : null;
        final List<String> labels = patch.containsKey("labels")
                ? labels(patch.get("labels"))
                : null;
        final boolean clearAttributes = patch.containsKey("clearAttributes");
        if (clearAttributes && !Boolean.TRUE.equals(patch.get("clearAttributes"))) {
            throw new BadArgument("clearAttributes must be true when present");
        }
        final Map<String, Object> attributes = patch.containsKey("attributes")
                ? attributes(patch.get("attributes"))
                : null;

        // Everything is valid; nothing below can reject.
        if (hasSummary) {
            report.setSummary(summary);
        }
        if (hasDescription) {
            report.setDescription(description);
        }
        if (severity != null) {
            report.setSeverity(severity);
        }
        if (labels != null) {
            // One call: clear-then-add would expose a label-less report between the two.
            report.setLabels(labels);
        }
        if (clearAttributes) {
            report.clearAllAttributes();
        }
        if (attributes != null) {
            for (final Map.Entry<String, Object> entry : attributes.entrySet()) {
                if (entry.getValue() == null) {
                    report.removeAttribute(entry.getKey());
                } else {
                    report.setAttribute(entry.getKey(), (Serializable) entry.getValue());
                }
            }
        }
    }

    /** @return false when the SDK declined the file (it returned null). */
    static boolean addFile(
            @NonNull final Report report,
            @NonNull final String path,
            @NonNull final String name,
            @Nullable final String mimeType,
            final boolean move
    ) {
        return report.addAttachment(new File(path), name, mimeType, move) != null;
    }

    /** @return false when the SDK declined the data (it returned null). */
    static boolean addData(
            @NonNull final Report report,
            @NonNull final byte[] data,
            @NonNull final String name,
            @Nullable final String mimeType
    ) {
        return report.addAttachment(data, name, mimeType) != null;
    }

    /**
     * A JS number as the value the SDK should store: a {@code Long} when it is
     * an exact integer (so an attribute of 3 is stored as 3, not 3.0), a
     * {@code Double} otherwise.
     */
    @NonNull
    static Object wireNumber(final double value) {
        if (value == Math.rint(value) && Math.abs(value) <= MAX_SAFE_INTEGER) {
            return (long) value;
        }
        return value;
    }

    @Nullable
    private static String optionalString(final Map<String, Object> patch, final String key)
            throws BadArgument {
        final Object value = patch.get(key);
        if (value != null && !(value instanceof String)) {
            throw new BadArgument(key + " must be a string or null");
        }
        return (String) value;
    }

    /**
     * Checked 1..5 BEFORE the SDK sees it: the SDK's one-argument
     * {@code fromIntValue} maps anything else to {@code VeryLow}, silently.
     */
    @NonNull
    private static IssueSeverity severity(@Nullable final Object value) throws BadArgument {
        if (value instanceof Number) {
            final double number = ((Number) value).doubleValue();
            if (number == Math.rint(number) && number >= 1 && number <= 5) {
                return IssueSeverity.fromIntValue((int) number);
            }
        }
        throw new BadArgument("severity must be an integer 1..5, got " + value);
    }

    @NonNull
    private static List<String> labels(@Nullable final Object value) throws BadArgument {
        if (!(value instanceof List)) {
            throw new BadArgument("labels must be an array of strings");
        }
        final List<String> result = new ArrayList<>();
        for (final Object label : (List<?>) value) {
            if (!(label instanceof String)) {
                throw new BadArgument("labels must all be strings");
            }
            result.add((String) label);
        }
        return result;
    }

    @NonNull
    private static Map<String, Object> attributes(@Nullable final Object value) throws BadArgument {
        if (!(value instanceof Map)) {
            throw new BadArgument("attributes must be a plain object");
        }
        final Map<String, Object> result = new HashMap<>();
        for (final Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
            final Object attribute = entry.getValue();
            final boolean valid = attribute == null
                    || attribute instanceof String
                    || attribute instanceof Boolean
                    || (attribute instanceof Number && isFinite((Number) attribute));
            if (!(entry.getKey() instanceof String) || !valid) {
                throw new BadArgument("attribute \"" + entry.getKey()
                        + "\" must be a string, boolean, finite number or null");
            }
            result.put((String) entry.getKey(), attribute);
        }
        return result;
    }

    private static boolean isFinite(@NonNull final Number number) {
        final double d = number.doubleValue();
        return !Double.isNaN(d) && !Double.isInfinite(d);
    }
}
