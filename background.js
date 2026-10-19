import {
  fetchEthPrice, formatBadge, nextColor, formatTitle, formatErrorTitle, COLOR_STALE, badgeTextColor,
} from './price.js';

export const ALARM = 'eth-price';

export async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

let inFlight = null;

export function refresh() {
  // Coalesce overlapping events to avoid stale price writes and color comparisons.
  if (!inFlight) {
    inFlight = refreshOnce().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function refreshOnce() {
  let prev;
  try {
    prev = (await chrome.storage.session.get('state')).state;
    const { price, source } = await fetchEthPrice((url, init) => globalThis.fetch(url, init));
    const color = nextColor(prev?.price, price, prev?.color);
    const at = Date.now();
    await chrome.action.setBadgeText({ text: formatBadge(price) });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeTextColor({ color: badgeTextColor(color) });
    await chrome.action.setTitle({ title: formatTitle({ price, source, at: new Date(at) }) });
    await chrome.storage.session.set({ state: { price, color, source, at } });
  } catch (error) {
    try {
      if (!prev) await chrome.action.setBadgeText({ text: '?' });
      await chrome.action.setBadgeBackgroundColor({ color: COLOR_STALE });
      await chrome.action.setBadgeTextColor({ color: badgeTextColor(COLOR_STALE) });
      await chrome.action.setTitle({
        title: formatErrorTitle({
          error: error instanceof Error ? error.message : String(error),
          lastPrice: prev?.price ?? null,
          lastAt: prev ? new Date(prev.at) : null,
        }),
      });
    } catch {
      // Chrome API failures must not reject refresh().
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  return refresh();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  return refresh();
});
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === ALARM ? refresh() : undefined);
chrome.action.onClicked.addListener(() => refresh());

ensureAlarm().catch(() => {});
