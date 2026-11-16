/**
 * Regenerates the reference tables of docs/launch-options.md from the accessor classes and the
 * committed copies of the SDKs' published manifests. Run it after changing an accessor or
 * regenerating a fixture; `yarn check:options-manifests` fails when the file is out of date.
 *
 * Usage: cli-generate-launch-options-doc.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderDoc, readHead } from './launch-options-doc.ts';
import { docPath, readAccessors, readFixture, readNoAccessor } from './cli-options-sources.ts';

const document = renderDoc({
  head: readHead(readFileSync(docPath, 'utf8')),
  android: readFixture('android'),
  ios: readFixture('ios'),
  accessors: readAccessors(),
  noAccessor: await readNoAccessor(),
});
writeFileSync(docPath, document);
console.log(`wrote ${docPath}`);
