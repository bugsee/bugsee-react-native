package com.bugsee.reactnative;

import com.bugsee.library.contracts.options.IssueSeverity;
import com.bugsee.library.contracts.options.IssueType;
import com.bugsee.library.contracts.reporting.Attachment;
import com.bugsee.library.contracts.reporting.Report;

import java.io.File;
import java.io.Serializable;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A {@link Report} built with {@link Proxy}: the interface has around forty
 * methods, and a hand-written fake would be mostly boilerplate that drifts
 * every time the SDK adds one.
 *
 * <p>Holds the state the bridge reads and writes, and records every method
 * called on it by name, so a test can assert on HOW the report was changed
 * (for example {@code setLabels} rather than {@code clearLabels} +
 * {@code addLabels}) and not only on the end state. A method this fake does
 * not model throws, so a test cannot pass by accident through a call the
 * bridge was never meant to make.
 */
final class FakeReports {

    private FakeReports() {
    }

    static final class State {
        String id = "report-1";
        IssueType type = IssueType.Bug;
        String summary;
        String description;
        IssueSeverity severity = IssueSeverity.High;
        final List<String> labels = new ArrayList<>();
        final Map<String, Serializable> attributes = new LinkedHashMap<>();
        final List<Integer> screenshotDisplayIds = new ArrayList<>();
        final List<String> attachmentNames = new ArrayList<>();
        /** When set, both {@code addAttachment} overloads return null, as the SDK does. */
        boolean rejectAttachments;

        /** Every method called, by name, in order. */
        final List<String> calls = new ArrayList<>();
        /** Arguments of the last {@code addAttachment(File, ...)} call. */
        Object[] lastFileAttachment;
        /** Arguments of the last {@code addAttachment(byte[], ...)} call. */
        Object[] lastDataAttachment;

        /** The calls that change the report, i.e. everything but getters. */
        List<String> mutations() {
            final List<String> result = new ArrayList<>();
            for (final String call : calls) {
                if (!call.startsWith("get")) {
                    result.add(call);
                }
            }
            return result;
        }
    }

    static Report create(final State state) {
        return (Report) Proxy.newProxyInstance(
                Report.class.getClassLoader(),
                new Class<?>[] { Report.class },
                (proxy, method, args) -> invoke(state, proxy, method, args));
    }

    @SuppressWarnings("unchecked")
    private static Object invoke(
            final State s,
            final Object proxy,
            final Method method,
            final Object[] args
    ) {
        final String name = method.getName();
        switch (name) {
            case "hashCode":
                return System.identityHashCode(proxy);
            case "equals":
                return proxy == args[0];
            case "toString":
                return "FakeReport(" + s.id + ")";
            default:
                break;
        }
        s.calls.add(name);
        switch (name) {
            case "getId":
                return s.id;
            case "getType":
                return s.type;
            case "getSummary":
                return s.summary;
            case "setSummary":
                s.summary = (String) args[0];
                return null;
            case "getDescription":
                return s.description;
            case "setDescription":
                s.description = (String) args[0];
                return null;
            case "getSeverity":
                return s.severity;
            case "setSeverity":
                s.severity = (IssueSeverity) args[0];
                return null;
            case "getLabels":
                return Collections.unmodifiableList(new ArrayList<>(s.labels));
            case "setLabels":
                s.labels.clear();
                s.labels.addAll((List<String>) args[0]);
                return null;
            case "clearLabels":
                s.labels.clear();
                return null;
            case "addLabels":
                s.labels.addAll((List<String>) args[0]);
                return null;
            case "addLabel":
                s.labels.add((String) args[0]);
                return null;
            case "getAttributes":
                return Collections.unmodifiableMap(new LinkedHashMap<>(s.attributes));
            case "setAttribute":
                s.attributes.put((String) args[0], (Serializable) args[1]);
                return null;
            case "removeAttribute":
                s.attributes.remove((String) args[0]);
                return null;
            case "clearAllAttributes":
                s.attributes.clear();
                return null;
            case "getScreenshotDisplayIds":
                return new ArrayList<>(s.screenshotDisplayIds);
            case "getAttachments": {
                final List<Attachment> result = new ArrayList<>();
                for (final String attachmentName : s.attachmentNames) {
                    result.add(attachment(attachmentName));
                }
                return result;
            }
            case "addAttachment": {
                final boolean isFile = args[0] instanceof File;
                if (isFile) {
                    s.lastFileAttachment = args.clone();
                } else {
                    s.lastDataAttachment = args.clone();
                }
                if (s.rejectAttachments) {
                    return null;
                }
                s.attachmentNames.add((String) args[1]);
                return attachment((String) args[1]);
            }
            default:
                throw new UnsupportedOperationException(
                        "FakeReports does not model Report." + name);
        }
    }

    private static Attachment attachment(final String name) {
        return (Attachment) Proxy.newProxyInstance(
                Attachment.class.getClassLoader(),
                new Class<?>[] { Attachment.class },
                (proxy, method, args) -> {
                    if ("getName".equals(method.getName())) {
                        return name;
                    }
                    throw new UnsupportedOperationException(
                            "FakeReports does not model Attachment." + method.getName());
                });
    }
}
