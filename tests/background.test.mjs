// Contract of background.js — MV3 service worker (ES module), imports './price.js'.
//
// On import (top level, synchronously):
//   chrome.runtime.onInstalled, chrome.runtime.onStartup, chrome.alarms.onAlarm, chrome.action.onClicked
//   each get exactly one listener; then ensureAlarm() is called once.
// export const ALARM = 'eth-price'
// export async function ensureAlarm(): chrome.alarms.get(ALARM); if absent ->
//   chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }). Existing alarm -> no create.
// export async function refresh(): never throws.
//   prev = (await chrome.storage.session.get('state')).state  // {price, color, source, at(ms)} or undefined
//   success (fetchEthPrice with (url, init) => globalThis.fetch(url, init)):
//     color = nextColor(prev?.price, price, prev?.color)
//     chrome.action.setBadgeText({text: formatBadge(price)})
//     chrome.action.setBadgeBackgroundColor({color})
//     chrome.action.setBadgeTextColor({color: '#ffffff'})
//     chrome.action.setTitle({title: formatTitle({price, source, at: new Date(at)})})
//     chrome.storage.session.set({state: {price, color, source, at}})   // at = Date.now() ms
//   failure: badge text untouched if prev exists, otherwise setBadgeText({text: '?'});
//     setBadgeBackgroundColor({color: COLOR_STALE});
//     setTitle({title: formatErrorTitle({error: err.message, lastPrice: prev?.price ?? null,
//                                        lastAt: prev ? new Date(prev.at) : null})});
//     stored state is not changed.
//   Concurrent calls are coalesced: while one refresh is in flight, further calls (alarm, click, events)
//   return that same in-flight promise and start no request; the next call after it settles fetches again.
//   A failed refresh does not block later ones.
// Listeners return their promise: onAlarm(a) -> a.name === ALARM ? refresh() : undefined;
//   onClicked -> refresh(); onInstalled / onStartup -> ensureAlarm() then refresh().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTitle, formatErrorTitle, COLOR_UP, COLOR_DOWN, COLOR_NEUTRAL, COLOR_STALE,
} from '../price.js';

const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT';
const COINBASE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';

let n = 0;

function makeChrome({ storage = {}, existingAlarm = null } = {}) {
  const calls = [];
  const listeners = { onInstalled: [], onStartup: [], onAlarm: [], onClicked: [] };
  const rec = (name) => async (arg) => { calls.push([name, arg]); };
  const chrome = {
    runtime: {
      onInstalled: { addListener: (f) => listeners.onInstalled.push(f) },
      onStartup: { addListener: (f) => listeners.onStartup.push(f) },
    },
    alarms: {
      get: async (name) => { calls.push(['alarms.get', name]); return existingAlarm; },
      create: async (name, info) => { calls.push(['alarms.create', name, info]); },
      onAlarm: { addListener: (f) => listeners.onAlarm.push(f) },
    },
    action: {
      setBadgeText: rec('setBadgeText'),
      setBadgeBackgroundColor: rec('setBadgeBackgroundColor'),
      setBadgeTextColor: rec('setBadgeTextColor'),
      setTitle: rec('setTitle'),
      onClicked: { addListener: (f) => listeners.onClicked.push(f) },
    },
    storage: {
      session: {
        get: async (key) => (key in storage ? { [key]: structuredClone(storage[key]) } : {}),
        set: async (obj) => { calls.push(['storage.set', structuredClone(obj)]); Object.assign(storage, structuredClone(obj)); },
      },
    },
  };
  return { chrome, calls, listeners, storage };
}

function setPrices(binancePrice, coinbasePrice = 2410.735) {
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(url);
    if (url === BINANCE_URL) {
      if (binancePrice === 'fail') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ symbol: 'ETHUSDT', price: String(binancePrice) }) };
    }
    if (url === COINBASE_URL) {
      if (coinbasePrice === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({ data: { amount: String(coinbasePrice) } }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return fetchCalls;
}

async function load(env) {
  globalThis.chrome = env.chrome;
  const mod = await import(`../background.js?i=${++n}`);
  await new Promise((r) => setImmediate(r)); // let top-level ensureAlarm() settle
  return mod;
}

const last = (calls, name) => calls.filter((c) => c[0] === name).at(-1);
const all = (calls, name) => calls.filter((c) => c[0] === name);

test('import registers one listener each and creates the 30s alarm when absent', async () => {
  const env = makeChrome();
  setPrices(2414.6);
  const mod = await load(env);
  assert.equal(mod.ALARM, 'eth-price');
  for (const k of ['onInstalled', 'onStartup', 'onAlarm', 'onClicked']) assert.equal(env.listeners[k].length, 1, k);
  assert.deepEqual(all(env.calls, 'alarms.create'), [['alarms.create', 'eth-price', { periodInMinutes: 0.5 }]]);
});

test('existing alarm is not re-created', async () => {
  const env = makeChrome({ existingAlarm: { name: 'eth-price', periodInMinutes: 0.5 } });
  setPrices(2414.6);
  await load(env);
  assert.equal(all(env.calls, 'alarms.create').length, 0);
  assert.ok(all(env.calls, 'alarms.get').length >= 1);
});

test('first successful refresh: badge text, neutral color, white text, title, stored state', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices(2414.6);
  const mod = await load(env);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '2414' }]);
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_NEUTRAL }]);
  assert.deepEqual(last(env.calls, 'setBadgeTextColor'), ['setBadgeTextColor', { color: '#ffffff' }]);
  const st = env.storage.state;
  assert.equal(st.price, 2414.6);
  assert.equal(st.color, COLOR_NEUTRAL);
  assert.equal(st.source, 'Binance');
  assert.equal(typeof st.at, 'number');
  assert.ok(Math.abs(Date.now() - st.at) < 5000);
  assert.deepEqual(last(env.calls, 'setTitle'),
    ['setTitle', { title: formatTitle({ price: 2414.6, source: 'Binance', at: new Date(st.at) }) }]);
});

test('direction colors across refreshes; unchanged keeps color', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices(2400);
  const mod = await load(env);
  await mod.refresh();
  setPrices(2414.6);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_UP }]);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_UP }]);
  setPrices(2390.1);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_DOWN }]);
  assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '2390' }]);
});

test('Binance down -> Coinbase price shown with source Coinbase', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices('fail', 2410.735);
  const mod = await load(env);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '2410' }]);
  assert.equal(env.storage.state.source, 'Coinbase');
});

test('all sources fail after a success: stale color, old text kept, error title, state unchanged, no throw', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices(2414.6);
  const mod = await load(env);
  await mod.refresh();
  const before = structuredClone(env.storage.state);
  const textCallsBefore = all(env.calls, 'setBadgeText').length;
  setPrices('fail', 'fail');
  await mod.refresh(); // must resolve
  const newTexts = all(env.calls, 'setBadgeText').slice(textCallsBefore);
  assert.ok(newTexts.every((c) => c[1].text === '2414'), 'badge text must keep the last price');
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_STALE }]);
  assert.deepEqual(env.storage.state, before);
  const title = last(env.calls, 'setTitle')[1].title;
  const expectedPrefix = formatErrorTitle({ error: 'X', lastPrice: 2414.6, lastAt: new Date(before.at) })
    .split('\n').slice(1).join('\n');
  assert.ok(title.startsWith('ETH: price update failed ('), title);
  assert.match(title, /Binance/);
  assert.match(title, /Coinbase/);
  assert.ok(title.endsWith(expectedPrefix), title);
});

test('all sources fail with no prior price: "?" badge, stale color, no-price title, nothing stored', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices('fail', 'fail');
  const mod = await load(env);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '?' }]);
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_STALE }]);
  assert.ok(last(env.calls, 'setTitle')[1].title.endsWith('\nNo price yet\nClick to retry'));
  assert.equal(env.storage.state, undefined);
});

test('alarm listener refreshes only for its alarm; click refreshes', async () => {
  const env = makeChrome({ existingAlarm: {} });
  let fetchCalls = setPrices(2414.6);
  await load(env);
  await env.listeners.onAlarm[0]({ name: 'other' });
  assert.equal(fetchCalls.length, 0);
  await env.listeners.onAlarm[0]({ name: 'eth-price' });
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '2414' }]);
  fetchCalls = setPrices(2500);
  await env.listeners.onClicked[0]({});
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '2500' }]);
});

test('onInstalled and onStartup ensure the alarm and refresh', async () => {
  for (const ev of ['onInstalled', 'onStartup']) {
    const env = makeChrome();
    const fetchCalls = setPrices(2414.6);
    await load(env);
    const createsBefore = all(env.calls, 'alarms.create').length;
    await env.listeners[ev][0]({});
    assert.equal(all(env.calls, 'alarms.create').length, createsBefore + 1, ev);
    assert.equal(fetchCalls.length, 1, ev);
    assert.deepEqual(last(env.calls, 'setBadgeText'), ['setBadgeText', { text: '2414' }], ev);
  }
});

test('concurrent refreshes are coalesced: one fetch in flight, both callers get its result', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices(100);
  const mod = await load(env);
  await mod.refresh(); // state: 100, neutral
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    await gate;
    return { ok: true, status: 200, json: async () => ({ symbol: 'ETHUSDT', price: '110' }) };
  };
  const a = mod.refresh();                       // e.g. the alarm
  const b = env.listeners.onClicked[0]({});      // a click while A is in flight
  const c = env.listeners.onAlarm[0]({ name: 'eth-price' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCalls.length, 1, 'only one request may be in flight');
  release();
  await Promise.all([a, b, c]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(env.storage.state.price, 110);
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_UP }]);
  assert.equal(all(env.calls, 'storage.set').length, 2, 'one write for the first refresh, one for the coalesced one');
  // once settled, the next refresh fetches again and compares against 110
  setPrices(105);
  await mod.refresh();
  assert.deepEqual(last(env.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_DOWN }]);
  assert.equal(env.storage.state.price, 105);
});

test('a failed refresh does not block the next one', async () => {
  const env = makeChrome({ existingAlarm: {} });
  setPrices('fail', 'fail');
  const mod = await load(env);
  await mod.refresh();
  const fetchCalls = setPrices(2414.6);
  await mod.refresh();
  assert.equal(fetchCalls.length, 1);
  assert.equal(env.storage.state.price, 2414.6);
});

test('previous price survives a service-worker restart (state read from storage.session)', async () => {
  const storage = {};
  const env1 = makeChrome({ storage, existingAlarm: {} });
  setPrices(2400);
  const mod1 = await load(env1);
  await mod1.refresh();
  const env2 = makeChrome({ storage, existingAlarm: {} });
  setPrices(2414.6);
  const mod2 = await load(env2);
  await mod2.refresh();
  assert.deepEqual(last(env2.calls, 'setBadgeBackgroundColor'), ['setBadgeBackgroundColor', { color: COLOR_UP }]);
});
