export const SOURCES = [
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
    parse: (json) => Number(json.price),
  },
  {
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
    parse: (json) => Number(json.data.amount),
  },
];

export async function fetchEthPrice(fetchImpl, sources = SOURCES, timeoutMs = 10000) {
  const failures = [];
  for (const source of sources) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timeout after ${timeoutMs} ms`));
          controller.abort();
        }, timeoutMs);
      });
      // Cover both the request and body parsing, even if abort is ignored.
      const request = (async () => {
        const response = await fetchImpl(source.url, {
          ...source.init,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const price = source.parse(await response.json());
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return { price, source: source.name };
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(failures.join('; '));
}

export const COLOR_UP = '#23d92b';
export const COLOR_DOWN = '#ef4444';
export const COLOR_NEUTRAL = '#39454b';
export const COLOR_STALE = '#6b7280';

export function badgeTextColor(bg) {
  if (bg === COLOR_UP) return '#16161f';
  if (bg === COLOR_NEUTRAL) return '#ededed';
  return '#ffffff';
}

export function formatBadge(price) {
  return price < 10000 ? String(Math.floor(price)) : `${Math.floor(price / 100) / 10}k`;
}

export function nextColor(prevPrice, price, prevColor) {
  if (prevPrice == null) return COLOR_NEUTRAL;
  if (price > prevPrice) return COLOR_UP;
  if (price < prevPrice) return COLOR_DOWN;
  return prevColor ?? COLOR_NEUTRAL;
}

export function formatUsd(price) {
  return '$' + price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

export function formatTitle({ price, source, at }) {
  return `ETH ${formatUsd(price)} · ${source} · ${formatTime(at)}\nClick to refresh now`;
}

export function formatErrorTitle({ error, lastPrice, lastAt }) {
  const last = lastPrice == null
    ? 'No price yet'
    : `Last: ${formatUsd(lastPrice)} at ${formatTime(lastAt)}`;
  return `ETH: price update failed (${error})\n${last}\nClick to retry`;
}
