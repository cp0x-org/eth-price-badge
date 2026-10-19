// Shipped files are English-only (public repository, English UI strings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no Cyrillic in shipped extension files', () => {
  for (const f of ['price.js', 'background.js', 'manifest.json']) {
    const s = readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(s, /[\u0400-\u052f]/, f);
  }
});
