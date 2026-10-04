'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Runs the file's tests from an empty temp directory. Under mutation a
 * path can lose its directory and land relative to the cwd; this keeps
 * such writes out of the repository.
 */
function useScratchCwd() {
  const original = process.cwd();
  let scratch;
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-scratch-cwd-'));
    process.chdir(scratch);
  });
  afterAll(() => {
    process.chdir(original);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
}

module.exports = { useScratchCwd };
