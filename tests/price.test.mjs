// Contract of price.js — pure logic of the ETH price badge (no chrome.* here).
//
// Exports:
//   SOURCES: [{ name, url, init?, parse(json) -> number }] in priority order.
//   fetchEthPrice(fetchImpl, sources = SOURCES, timeoutMs = 10000) -> Promise<{ price, source }>
//     Tries sources in order. A source fails on: fetch rejecting, !res.ok, res.json() rejecting,
//     parse() throwing, a result that is not a finite number > 0, or no answer within timeoutMs
//     (fetchImpl gets init.signal and must be aborted). All failed -> rejects with an Error whose
//     message names every source and its reason.
//   formatBadge(price) -> string: price < 10000 -> String(Math.floor(price));
//     price >= 10000 -> `${Math.floor(price / 100) / 10}k`.
//   COLOR_UP '#008800', COLOR_DOWN '#c45c50', COLOR_NEUTRAL '#607d8b', COLOR_STALE '#9e9e9e'.
//   nextColor(prevPrice, price, prevColor): prevPrice null/undefined -> COLOR_NEUTRAL;
//     price > prevPrice -> COLOR_UP; price < prevPrice -> COLOR_DOWN; equal -> prevColor ?? COLOR_NEUTRAL.
//   formatUsd(price) -> '$' + price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})
//   formatTime(date) -> date.toLocaleTimeString(undefined,
//     {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'})  // browser locale, 24h
//   formatTitle({price, source, at}) ->
//     `ETH ${formatUsd(price)} · ${source} · ${formatTime(at)}\nClick to refresh now`
//   formatErrorTitle({error, lastPrice, lastAt}) ->
//     `ETH: price update failed (${error})\nLast: ${formatUsd(lastPrice)} at ${formatTime(lastAt)}\nClick to retry`
//     when lastPrice is null/undefined the middle line is `No price yet`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES, fetchEthPrice, formatBadge, nextColor, formatUsd, formatTime,
  formatTitle, formatErrorTitle, COLOR_UP, COLOR_DOWN, COLOR_NEUTRAL, COLOR_STALE,
} from '../price.js';

const TIME_OPTS = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT';
const COINBASE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
const BINANCE_BODY = { symbol: 'ETHUSDT', price: '2414.60000000' };
const COINBASE_BODY = { data: { amount: '2410.735', base: 'ETH', currency: 'USD' } };

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

// fake fetch: routes by URL; records calls; handler may be a function (url, init) -> Response|Promise
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const h = routes[url];
    if (h === undefined) throw new Error(`unexpected url ${url}`);
    return typeof h === 'function' ? h(url, init) : h;
  };
  f.calls = calls;
  return f;
}

test('sources: Binance first, Coinbase second, exact URLs, parse live response shapes', () => {
  assert.equal(SOURCES.length, 2);
  assert.equal(SOURCES[0].name, 'Binance');
  assert.equal(SOURCES[0].url, BINANCE_URL);
  assert.equal(SOURCES[0].parse(BINANCE_BODY), 2414.6);
  assert.equal(SOURCES[1].name, 'Coinbase');
  assert.equal(SOURCES[1].url, COINBASE_URL);
  assert.equal(SOURCES[1].parse(COINBASE_BODY), 2410.735);
});

test('fetchEthPrice: Binance ok -> Binance price, Coinbase not called', async () => {
  const f = fakeFetch({ [BINANCE_URL]: ok(BINANCE_BODY), [COINBASE_URL]: ok(COINBASE_BODY) });
  assert.deepEqual(await fetchEthPrice(f), { price: 2414.6, source: 'Binance' });
  assert.deepEqual(f.calls.map((c) => c.url), [BINANCE_URL]);
  assert.ok(f.calls[0].init && f.calls[0].init.signal, 'fetch must receive an AbortSignal');
});

for (const [label, binance] of [
  ['HTTP 451', status(451)],
  ['HTTP 500', status(500)],
  ['network error', () => { throw new TypeError('Failed to fetch'); }],
  ['bad json', { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }],
  ['missing price field', ok({ symbol: 'ETHUSDT' })],
  ['non-numeric price', ok({ symbol: 'ETHUSDT', price: 'abc' })],
  ['zero price', ok({ symbol: 'ETHUSDT', price: '0' })],
  ['negative price', ok({ symbol: 'ETHUSDT', price: '-5' })],
]) {
  test(`fetchEthPrice: Binance ${label} -> falls back to Coinbase`, async () => {
    const f = fakeFetch({ [BINANCE_URL]: binance, [COINBASE_URL]: ok(COINBASE_BODY) });
    assert.deepEqual(await fetchEthPrice(f), { price: 2410.735, source: 'Coinbase' });
    assert.deepEqual(f.calls.map((c) => c.url), [BINANCE_URL, COINBASE_URL]);
  });
}

test('fetchEthPrice: hanging source is aborted after timeoutMs and next source is used', async () => {
  let aborted = false;
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  });
  const f = fakeFetch({ [BINANCE_URL]: hang, [COINBASE_URL]: ok(COINBASE_BODY) });
  const t0 = Date.now();
  assert.deepEqual(await fetchEthPrice(f, SOURCES, 50), { price: 2410.735, source: 'Coinbase' });
  assert.ok(aborted, 'hanging request must be aborted via init.signal');
  assert.ok(Date.now() - t0 < 2000);
});

test('fetchEthPrice: all sources fail -> rejects naming every source', async () => {
  const f = fakeFetch({ [BINANCE_URL]: status(503), [COINBASE_URL]: () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(fetchEthPrice(f), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Binance/);
    assert.match(err.message, /Coinbase/);
    return true;
  });
});

test('fetchEthPrice: custom source list with init is passed through (method/body/headers)', async () => {
  const src = [{ name: 'X', url: 'https://x.test/q', init: { method: 'POST', body: '{}', headers: { a: 'b' } }, parse: (j) => j.p }];
  const f = fakeFetch({ 'https://x.test/q': ok({ p: 3000 }) });
  assert.deepEqual(await fetchEthPrice(f, src), { price: 3000, source: 'X' });
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.body, '{}');
  assert.deepEqual(f.calls[0].init.headers, { a: 'b' });
  assert.ok(f.calls[0].init.signal);
});

test('formatBadge', () => {
  assert.equal(formatBadge(2414.6), '2414');
  assert.equal(formatBadge(2414.99), '2414');
  assert.equal(formatBadge(999.9), '999');
  assert.equal(formatBadge(9999.99), '9999');
  assert.equal(formatBadge(10000), '10k');
  assert.equal(formatBadge(10234.5), '10.2k');
  assert.equal(formatBadge(99999), '99.9k');
});

test('colors and nextColor', () => {
  assert.equal(COLOR_UP, '#008800');
  assert.equal(COLOR_DOWN, '#c45c50');
  assert.equal(COLOR_NEUTRAL, '#607d8b');
  assert.equal(COLOR_STALE, '#9e9e9e');
  assert.equal(nextColor(null, 2414.6, undefined), COLOR_NEUTRAL);
  assert.equal(nextColor(undefined, 2414.6, COLOR_UP), COLOR_NEUTRAL);
  assert.equal(nextColor(2400, 2414.6, COLOR_DOWN), COLOR_UP);
  assert.equal(nextColor(2420, 2414.6, COLOR_UP), COLOR_DOWN);
  assert.equal(nextColor(2414.6, 2414.6, COLOR_UP), COLOR_UP);
  assert.equal(nextColor(2414.6, 2414.6, undefined), COLOR_NEUTRAL);
});

test('formatUsd / formatTime', () => {
  assert.equal(formatUsd(2414.6), '$2,414.60');
  assert.equal(formatUsd(10234.567), '$10,234.57');
  const at = new Date(2026, 9, 19, 0, 50, 5);
  assert.equal(formatTime(at), at.toLocaleTimeString(undefined, TIME_OPTS));
  assert.match(formatTime(new Date(2026, 9, 19, 22, 5, 45)), /22.05.45/);
});

test('formatTitle', () => {
  const at = new Date(2026, 9, 19, 0, 50, 5);
  const t = at.toLocaleTimeString(undefined, TIME_OPTS);
  assert.equal(formatTitle({ price: 2414.6, source: 'Binance', at }),
    `ETH $2,414.60 · Binance · ${t}\nClick to refresh now`);
});

test('formatErrorTitle with and without last price', () => {
  const at = new Date(2026, 9, 19, 0, 50, 5);
  const t = at.toLocaleTimeString(undefined, TIME_OPTS);
  assert.equal(formatErrorTitle({ error: 'Binance: HTTP 503; Coinbase: Failed to fetch', lastPrice: 2414.6, lastAt: at }),
    `ETH: price update failed (Binance: HTTP 503; Coinbase: Failed to fetch)\nLast: $2,414.60 at ${t}\nClick to retry`);
  assert.equal(formatErrorTitle({ error: 'x', lastPrice: null, lastAt: null }),
    'ETH: price update failed (x)\nNo price yet\nClick to retry');
});
