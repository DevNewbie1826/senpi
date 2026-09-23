// Shared by the gpt-5.6 and gpt-6 family presets (2026-09-23), replacing their test-first
// rule: a test as the proof of every change with a seam grew change-certifying tests on
// simple edits. Claude and Kimi presets carry the same stance in their Scope paragraph.
export const TEST_DECISION =
	"Read existing tests first - the behavior of record: update those your change makes stale; one wrong before your change is a finding, not a test to edit green. Reproduce a bug before fixing it. The run proves the change: add a test only where the repository keeps tests for this behavior and a regression would otherwise pass unnoticed - sized like its neighbors, never restating the change.";
