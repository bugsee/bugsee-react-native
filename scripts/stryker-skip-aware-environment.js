/**
 * Jest's node environment for the scripts mutation run (stryker.scripts.json),
 * closing a hole in Stryker's per-test coverage.
 *
 * Stryker's jest environment sets the current test id on `test_start` and
 * clears it on `test_done`. jest-circus emits `test_start` for a skipped or
 * todo test, then `test_skip` / `test_todo`, and never `test_done`. So the
 * skipped test's id stays set, and code that the next test file in the same
 * worker runs at load time is credited to that skipped test instead of being
 * static. Example: raw-messages-tree.test.ts scans the packages at module
 * scope. Whether its ~380 mutants came out "static, ignored" or "covered by
 * releasable-pins' skipped test, survived" depended on which file the worker
 * ran first, which moved the score by about 2 points. Clearing the id on the
 * events that end a test without `test_done` makes the result independent of
 * file order.
 */
const { TestEnvironment } = require('jest-environment-node');

class SkipAwareEnvironment extends TestEnvironment {
  handleTestEvent(event) {
    if (event.name === 'test_skip' || event.name === 'test_todo') {
      const context = this.global[this.global.__strykerGlobalNamespace__ ?? '__stryker__'];
      if (context !== undefined && context !== null) {
        context.currentTestId = undefined;
      }
    }
  }
}

module.exports = SkipAwareEnvironment;
