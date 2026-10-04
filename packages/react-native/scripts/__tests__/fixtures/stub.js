'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STUB = path.join(__dirname, 'symbol-stub-server.js');

/** Starts symbol-stub-server.js in its own process; resolves `{ child, port }`. */
function startStub(logPath, extra = []) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [STUB, '--log', logPath, ...extra], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) {
        resolve({ child, port: JSON.parse(out.split('\n')[0]).port });
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`stub exited ${code}`)));
  });
}

function stopStub(stub) {
  return new Promise((resolve) => {
    stub.child.removeAllListeners('exit');
    stub.child.on('exit', () => resolve());
    stub.child.kill('SIGTERM');
  });
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = { readLog, startStub, stopStub };
