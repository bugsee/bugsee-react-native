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

    /** JS numbers are doubles; an integral one becomes a Long so the SDK stores 3, not 3.0. */
    @Test
    public void integralNumbersCrossAsLong() {
        assertEquals(3L, ReportOps.wireNumber(3.0));
        assertEquals(-9_007_199_254_740_992L, ReportOps.wireNumber(-9_007_199_254_740_992.0));
        assertEquals(2.5, ReportOps.wireNumber(2.5));
        assertEquals(1e300, ReportOps.wireNumber(1e300));
    }
}
