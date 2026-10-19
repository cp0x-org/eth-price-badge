// Contract of manifest.json (Manifest V3, loaded unpacked in Chrome 153).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('manifest v3 basics', () => {
  assert.equal(m.manifest_version, 3);
  assert.match(m.name, /ETH/);
  assert.equal(typeof m.version, 'string');
  assert.deepEqual(m.background, { service_worker: 'background.js', type: 'module' });
});

test('minimal permissions: alarms + storage, hosts: Binance + Coinbase only', () => {
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'storage']);
  assert.deepEqual([...m.host_permissions].sort(), ['https://api.binance.com/*', 'https://api.coinbase.com/*']);
});

test('toolbar action without popup (click = refresh), icons exist', () => {
  assert.ok(m.action, 'action required');
  assert.equal(m.action.default_popup, undefined);
  const want = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
  assert.deepEqual(m.icons, want);
  assert.deepEqual(m.action.default_icon, { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
  for (const p of Object.values(want)) assert.ok(existsSync(path.join(root, p)), p);
});
