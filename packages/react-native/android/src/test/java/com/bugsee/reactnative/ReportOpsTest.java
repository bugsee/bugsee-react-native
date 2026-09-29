package com.bugsee.reactnative;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.bugsee.library.contracts.options.IssueSeverity;
import com.bugsee.library.contracts.options.IssueType;
import com.bugsee.library.contracts.reporting.Report;

import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

public class ReportOpsTest {

    private FakeReports.State state;
    private Report report;

    @Before
    public void setUp() {
        state = new FakeReports.State();
        report = FakeReports.create(state);
    }

    private static Map<String, Object> patch(final Object... keyValues) {
        final Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            result.put((String) keyValues[i], keyValues[i + 1]);
        }
        return result;
    }

    private void assertRejected(final Map<String, Object> patch) {
        try {
            ReportOps.apply(report, patch);
            fail("expected BadArgument for " + patch);
        } catch (final ReportOps.BadArgument expected) {
            // The assertion is reaching here.
        }
    }

    /**
     * {@code Critical} is ordinal 3 and value 4. Only the value is the number
     * both platforms and the JS type speak.
     */
    @Test
    public void readsSeverityByValueNotOrdinal() {
        state.severity = IssueSeverity.Critical;
        assertEquals(4, ((Number) ReportOps.read(report).get("severity")).intValue());
    }

    @Test
    public void appliesSeverityOneToFive() throws Exception {
        final IssueSeverity[] expected = {
                IssueSeverity.VeryLow, IssueSeverity.Medium, IssueSeverity.High,
                IssueSeverity.Critical, IssueSeverity.Blocker,
        };
        for (int value = 1; value <= 5; value++) {
            ReportOps.apply(report, patch("severity", (long) value));
            assertEquals(expected[value - 1], state.severity);
        }
    }

    /**
     * The SDK's one-argument {@code fromIntValue} maps anything unknown to
     * {@code VeryLow}: an unchecked 0 would silently LOWER a report's severity.
     */
    @Test
    public void rejectsSeverityZeroAndSixAndLeavesTheReportAlone() {
        state.severity = IssueSeverity.High;
        assertRejected(patch("severity", 0L));
        assertRejected(patch("severity", 6L));
        assertRejected(patch("severity", 2.5));
        assertRejected(patch("severity", "3"));
        assertEquals(IssueSeverity.High, state.severity);
        assertEquals(Collections.emptyList(), state.mutations());
    }

    /** A valid field next to an invalid one must not land on its own. */
    @Test
    public void patchIsAllOrNothing() {
        assertRejected(patch(
                "summary", "new summary",
                "labels", Arrays.asList("a", "b"),
                "attributes", patch("k", "v"),
                "severity", 9L));
        assertNull(state.summary);
        assertTrue(state.labels.isEmpty());
        assertTrue(state.attributes.isEmpty());
        assertEquals(Collections.emptyList(), state.mutations());
    }

    /**
     * Parity with the JS proxy, which rejects it before crossing: an empty
     * attribute name is a bad argument like any other malformed field, and
     * fails the whole patch -- the valid name next to it included.
     */
    @Test
    public void rejectsAnEmptyAttributeNameAndAppliesNothing() {
        try {
            ReportOps.apply(report, patch(
                    "summary", "new summary",
                    "attributes", patch("ok", "v", "", "x")));
            fail("expected BadArgument");
        } catch (final ReportOps.BadArgument expected) {
            assertEquals("attribute name must be a non-empty string", expected.getMessage());
        }
        assertNull(state.summary);
        assertTrue(state.attributes.isEmpty());
        assertEquals(Collections.emptyList(), state.mutations());
    }

    /**
     * One call, not clear-then-add: between the two, the SDK (or a concurrent
     * reader) would see a report with no labels at all.
     */
    @Test
    public void labelsReplaceThroughSetLabels() throws Exception {
        state.labels.add("old");
        ReportOps.apply(report, patch("labels", Arrays.asList("x", "y")));
        assertEquals(Arrays.asList("x", "y"), state.labels);
        assertEquals(Collections.singletonList("setLabels"), state.mutations());
    }

    @Test
    public void nullAttributeRemoves() throws Exception {
        state.attributes.put("gone", "value");
        state.attributes.put("kept", "value");
        ReportOps.apply(report, patch("attributes", patch("gone", null, "added", 7L)));
        assertFalse(state.attributes.containsKey("gone"));
        assertEquals("value", state.attributes.get("kept"));
        assertEquals(7L, state.attributes.get("added"));
    }

    /** Clear-then-set in one patch, whatever order the map iterates in. */
    @Test
    public void clearAttributesRunsBeforeAttributes() throws Exception {
        state.attributes.put("old", "value");
        ReportOps.apply(report, patch(
                "attributes", patch("fresh", true),
                "clearAttributes", true));
        assertEquals(Collections.singletonMap("fresh", (Object) true), new HashMap<Object, Object>(state.attributes));
        assertEquals(Arrays.asList("clearAllAttributes", "setAttribute"), state.mutations());
    }

    /** A misspelled key must fail loudly, not drop part of the patch. */
    @Test
    public void unknownPatchKeyIsRejected() {
        assertRejected(patch("summary", "s", "sumary", "typo"));
        assertNull(state.summary);
    }

    /** {@code toString()}, which is the wire string; {@code name()} would be "Crash". */
    @Test
    public void typeCrossesAsItsString() {
        state.type = IssueType.Crash;
        assertEquals("crash", ReportOps.typeOf(report));
    }

    /** The SNAPSHOT may predate bugsee-android#178, which sorts these at the source. */
    @Test
    public void screenshotIdsAreSortedAscending() {
        state.screenshotDisplayIds.addAll(Arrays.asList(2, 0, 1));
        assertEquals(Arrays.asList(0, 1, 2), ReportOps.read(report).get("screenshotDisplayIds"));
    }

    @Test
    public void aNullFromTheSdkIsARejectedAttachment() {
        state.rejectAttachments = true;
        assertFalse(ReportOps.addData(report, new byte[] { 1 }, "blob", null));
        assertFalse(ReportOps.addFile(report, "/nonexistent", "file", null, false));

        state.rejectAttachments = false;
        assertTrue(ReportOps.addData(report, new byte[] { 1 }, "blob", "application/octet-stream"));
    }

    @Test
    public void fileAttachmentPassesMoveThrough() throws Exception {
        final File file = File.createTempFile("bugsee-rn", ".log");
        file.deleteOnExit();

        assertTrue(ReportOps.addFile(report, file.getAbsolutePath(), "app.log", "text/plain", true));
        assertArrayEquals(new Object[] { file, "app.log", "text/plain", true }, state.lastFileAttachment);

        assertTrue(ReportOps.addFile(report, file.getAbsolutePath(), "app.log", null, false));
        assertArrayEquals(new Object[] { file, "app.log", null, false }, state.lastFileAttachment);
    }

    /** The whole snapshot the JS side normalises, in one read. */
    @Test
    public void readReturnsTheWholeSnapshot() {
        state.summary = "s";
        state.description = "d";
        state.labels.add("l");
        state.attributes.put("n", 1L);
        state.attachmentNames.add("a.txt");

        final Map<String, Object> read = ReportOps.read(report);

        assertEquals("s", read.get("summary"));
        assertEquals("d", read.get("description"));
        assertEquals(Collections.singletonList("l"), read.get("labels"));
        assertEquals(Collections.singletonMap("n", (Object) 1L), read.get("attributes"));
        assertEquals(Collections.singletonList("a.txt"), read.get("attachmentNames"));
    }

    /**
     * The patch as {@code reportUpdate} now receives it: JSON text, parsed by
     * {@link BridgeJson}. A null summary and description clear them, and a null
     * attribute removes it -- the three edits iOS's object conversion dropped.
     */
    @Test
    public void aParsedPatchClearsAndRemoves() throws Exception {
        state.summary = "old summary";
        state.description = "old description";
        state.attributes.put("gone", "value");
        state.attributes.put("kept", "value");

        ReportOps.apply(report, BridgeJson.parseObject(
                "{\"summary\":null,\"description\":null,"
                        + "\"attributes\":{\"gone\":null,\"count\":3,\"ratio\":0.5}}"));

        assertNull(state.summary);
        assertNull(state.description);
        assertFalse(state.attributes.containsKey("gone"));
        assertEquals("value", state.attributes.get("kept"));
        // Integral stays an integer for the SDK's writer; a fraction stays a double.
        assertEquals(3, state.attributes.get("count"));
        assertEquals(0.5, state.attributes.get("ratio"));
        assertTrue(state.mutations().contains("setSummary"));
        assertTrue(state.mutations().contains("setDescription"));
        assertTrue(state.mutations().contains("removeAttribute"));
    }

    /** Parsing does not bypass validation: a bad field still applies nothing. */
    @Test
    public void aParsedPatchIsStillAllOrNothing() throws Exception {
        state.summary = "old summary";
        assertRejected(BridgeJson.parseObject(
                "{\"summary\":null,\"attributes\":{\"gone\":null},\"severity\":0}"));
        assertEquals("old summary", state.summary);
        assertEquals(Collections.emptyList(), state.mutations());
    }

    /**
     * {@code reportUpdate}'s entry point: the JSON text itself. Text that is
     * not a JSON object is the same BadArgument as a bad field -- the module
     * maps both to E_REPORT_BAD_ARGUMENT -- and touches nothing.
     */
    @Test
    public void applyJsonParsesThenApplies() throws Exception {
        state.summary = "old summary";
        ReportOps.applyJson(report, "{\"summary\":null,\"labels\":[\"a\"]}");
        assertNull(state.summary);
        assertEquals(Collections.singletonList("a"), state.labels);
    }

    @Test
    public void applyJsonRejectsTextThatIsNotAJsonObjectAndAppliesNothing() {
        state.summary = "old summary";
        for (final String json : new String[] { "{\"summary\":", "[]", "", "null" }) {
            try {
                ReportOps.applyJson(report, json);
                fail("expected BadArgument for " + json);
            } catch (final ReportOps.BadArgument expected) {
                assertTrue(expected.getMessage(), expected.getMessage().startsWith("update() patch is not a JSON object"));
            }
        }
        assertEquals("old summary", state.summary);
        assertEquals(Collections.emptyList(), state.mutations());
    }

    /** A JSON severity is an Integer now, not a Double; 1..5 still maps by value. */
    @Test
    public void aParsedSeverityIsAppliedByValue() throws Exception {
        ReportOps.apply(report, BridgeJson.parseObject("{\"severity\":4}"));
        assertEquals(IssueSeverity.Critical, state.severity);
    }

    /**
     * The same four values the old {@code wireNumber} pinned, now through the
     * JSON transport that replaced it: an integral number reaches the SDK as
     * an integer (Integer, or Long past int range) so it stores 3, not 3.0;
     * a fraction, or a number too large to be an exact integer, as a Double.
     */
    @Test
    public void integralNumbersCrossAsIntegers() throws Exception {
        ReportOps.applyJson(report, "{\"attributes\":{\"three\":3,"
                + "\"minSafe\":-9007199254740992,\"frac\":2.5,\"huge\":1e300}}");
        assertEquals(Integer.valueOf(3), state.attributes.get("three"));
        assertEquals(Long.valueOf(-9_007_199_254_740_992L), state.attributes.get("minSafe"));
        assertEquals(Double.valueOf(2.5), state.attributes.get("frac"));
        assertEquals(Double.valueOf(1e300), state.attributes.get("huge"));
    }
}
