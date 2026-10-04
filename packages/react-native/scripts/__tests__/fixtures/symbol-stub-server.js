'use strict';

/**
 * Local stand-in for the Bugsee symbol API, for tests and build validation.
 * It never forwards anything. `POST /apps/<token>/symbols` is answered with
 * a presigned URL on this same server; the `PUT` to it is unpacked, and the
 * map inside is read for its `debug_id`. Every request is appended to the
 * JSON-lines file named by `--log` (or BUGSEE_STUB_LOG). The token segment is
 * recorded apart from the path, so the path in the log never carries it.
 * Prints `{"port":N}` on stdout once listening; `--port` picks the port.
 */

const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const http = require('node:http');
const zlib = require('node:zlib');

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const logPath = argValue('--log') || process.env.BUGSEE_STUB_LOG;
const port = Number(argValue('--port') || 0);
const failWith = Number(argValue('--fail') || 0);

function zipEntries(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let content = null;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data);
    else if (method === 93 && typeof zlib.zstdDecompressSync === 'function') {
      content = zlib.zstdDecompressSync(data);
    }
    entries.push({ name, method, content });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function record(entry) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

let puts = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const symbols = /^\/apps\/([^/]+)\/symbols$/.exec(req.url);
    const entry = { method: req.method, path: req.url };
    if (symbols) {
      entry.path = '/apps/<token>/symbols';
      entry.token = decodeURIComponent(symbols[1]);
    }
    if (req.method === 'POST') {
      try {
        entry.json = JSON.parse(body.toString('utf8'));
      } catch {
        entry.bytes = body.length;
      }
      record(entry);
      if (failWith) {
        res.writeHead(failWith, { 'content-type': 'application/json' });
        res.end('{"ok":false}');
        return;
      }
      puts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, endpoint: `http://127.0.0.1:${server.address().port}/put/${puts}` }));
      return;
    }
    if (req.method === 'PUT') {
      entry.bytes = body.length;
      entry.entries = zipEntries(body).map(({ name, method, content }) => {
        let debugId = null;
        if (content) {
          try {
            const map = JSON.parse(content.toString('utf8'));
            debugId = map.debug_id ?? null;
          } catch {
            debugId = null;
          }
        }
        return { name, method, debugId };
      });
      record(entry);
      res.writeHead(200);
      res.end();
      return;
    }
    record(entry);
    res.writeHead(404);
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
