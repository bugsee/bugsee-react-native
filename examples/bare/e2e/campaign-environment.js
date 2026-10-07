/**
 * Jest's node environment, plus one thing Jest's `--json` results leave out:
 * whether a test was declared `it.failing` (a known product bug pinned to
 * its correct behaviour). Jest reports such a test as "passed" while the
 * bug is still there, and the campaign evidence must say FAIL (known)
 * instead (scripts/campaign-evidence.ts).
 *
 * With `E2E_FAILING_SIDECAR=<file>` set, every test that runs appends one
 * JSON line there: `{"fullName": "<describe titles> <test title>", "failing": <bool>}`,
 * with `fullName` built as Jest builds it. scripts/cli-campaign-run.ts sets
 * both this environment (`--testEnvironment`) and the variable.
 */
const { appendFileSync } = require('node:fs');
const NodeEnvironment = require('jest-environment-node').TestEnvironment;

class CampaignEnvironment extends NodeEnvironment {
  handleTestEvent(event) {
    const file = process.env.E2E_FAILING_SIDECAR;
    if (event.name !== 'test_done' || !file) {
      return;
    }
    const names = [event.test.name];
    for (let block = event.test.parent; block && block.name !== 'ROOT_DESCRIBE_BLOCK'; block = block.parent) {
      names.unshift(block.name);
    }
    appendFileSync(file, `${JSON.stringify({ fullName: names.join(' '), failing: event.test.failing === true })}\n`);
  }
}

module.exports = CampaignEnvironment;
