'use strict';

/**
 * Jest setupFiles, so it runs before every test file, under `yarn test` and
 * under every Stryker run (all three configs load the jest config in
 * package.json). bugsee-cli defaults to https://api.bugsee.com; a test, or a
 * mutant, that loses its stub endpoint must not reach it.
 *
 * - BUGSEE_ENDPOINT is a dead loopback port (the repo's dead-endpoint
 *   convention), inherited by every child process.
 * - HTTPS_PROXY points at the same closed port unless one is already set, so
 *   an https URL that slips past still goes nowhere; NO_PROXY keeps the
 *   loopback stubs direct.
 * - Spawning bugsee-cli with an endpoint that is not loopback throws.
 */

const cp = require('node:child_process');
const process = require('node:process');

const DEAD_ENDPOINT = 'http://127.0.0.1:9';
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const CLI = /@bugsee[/\\]cli|bugsee-cli/;
const GUARDED = Symbol.for('bugsee.noNetworkGuard');

process.env.BUGSEE_ENDPOINT = DEAD_ENDPOINT;
if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
  process.env.HTTPS_PROXY = DEAD_ENDPOINT;
}
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

function guard(name) {
  const original = cp[name];
  if (original[GUARDED]) return;
  const wrapped = function guardedSpawn(file, args, options) {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    if ([file, ...argv].some((part) => typeof part === 'string' && CLI.test(part))) {
      const endpoint = ((opts && opts.env) || process.env).BUGSEE_ENDPOINT || '';
      if (!LOOPBACK.test(endpoint)) {
        throw new Error(`refusing to spawn bugsee-cli without a loopback BUGSEE_ENDPOINT (got "${endpoint}")`);
      }
    }
    return original.apply(this, arguments);
  };
  wrapped[GUARDED] = true;
  cp[name] = wrapped;
}

guard('spawnSync');
guard('spawn');
