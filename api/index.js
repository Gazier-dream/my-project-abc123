const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const MARKET_TTL_MS = 45_000;
const RETRY_DELAY_MS = 300;
let cached;
let pending;
let retryAfter = 0;
let lastError;
let tokenCached;
let tokenPending;
let tokenRetryAfter = 0;
let tokenLastError;

const unavailable = message => ({ coins: [], source: 'CoinGecko', mode: 'unavailable', error: message });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['coin-images.coingecko.com', 'assets.coingecko.com'].includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function providerError(response) {
  if ([401, 403].includes(response.status)) return 'CoinGecko rejected the API key. Update COINGECKO_DEMO_API_KEY and retry.';
  if (response.status === 429) return 'CoinGecko rate limit reached. Showing the most recent market data.';
  return 'CoinGecko is temporarily unavailable. Showing the most recent market data.';
}

async function fetchMarkets() {
  const headers = { accept: 'application/json' };
  if (process.env.COINGECKO_DEMO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_DEMO_API_KEY;
  let failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=true',
        { headers, signal: AbortSignal.timeout(20_000) }
      );
      if (!response.ok) throw new Error(providerError(response));
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length || rows.some(coin => !coin.id || !coin.name || !coin.symbol)) {
        throw new Error('CoinGecko returned incomplete market data.');
      }
      return rows;
    } catch (error) {
      failure = error;
      if (attempt === 0 && !/rejected the API key/i.test(error.message)) await delay(RETRY_DELAY_MS);
    }
  }
  const message = failure?.name === 'TimeoutError'
    ? 'CoinGecko timed out. Showing the most recent market data.'
    : failure?.message === 'fetch failed'
      ? 'Cannot connect to CoinGecko. Showing the most recent market data.'
      : failure?.message || 'Market data is temporarily unavailable.';
  throw new Error(message);
}

async function marketData() {
  if (cached && Date.now() - cached.time < MARKET_TTL_MS) return cached.data;
  if (pending) return pending;
  if (Date.now() < retryAfter) {
    return cached ? { ...cached.data, mode: 'stale', notice: lastError } : unavailable(lastError || 'Market data is temporarily unavailable.');
  }
  pending = (async () => {
    try {
      const rows = await fetchMarkets();
      const numberOrNull = value => Number.isFinite(value) ? value : null;
      const coins = rows.map(coin => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        image: safeImage(coin.image),
        currentPrice: numberOrNull(coin.current_price),
        marketCap: numberOrNull(coin.market_cap),
        marketCapRank: numberOrNull(coin.market_cap_rank),
        totalVolume: numberOrNull(coin.total_volume),
        priceChangePercentage24h: numberOrNull(coin.price_change_percentage_24h),
        lastUpdated: typeof coin.last_updated === 'string' && Number.isFinite(Date.parse(coin.last_updated)) ? coin.last_updated : null,
        sparkline7d: (coin.sparkline_in_7d?.price || []).filter(Number.isFinite)
      }));
      const data = { coins, source: 'CoinGecko', mode: 'live', retrievedAt: new Date().toISOString() };
      cached = { time: Date.now(), data };
      lastError = undefined;
      return data;
    } catch (error) {
      lastError = error.message;
      retryAfter = Date.now() + 20_000;
      return cached ? { ...cached.data, mode: 'stale', notice: lastError } : unavailable(lastError);
    }
  })();
  try { return await pending; } finally { pending = null; }
}


async function tokenData() {
  if (tokenCached && Date.now() - tokenCached.time < 15_000) return tokenCached.data;
  if (tokenPending) return tokenPending;
  if (Date.now() < tokenRetryAfter) {
    return tokenCached ? { ...tokenCached.data, mode: 'stale', notice: tokenLastError } : unavailable(tokenLastError || 'Bitcoin and Ethereum prices are temporarily unavailable.');
  }
  tokenPending = (async () => {
    const headers = { accept: 'application/json' };
    if (process.env.COINGECKO_DEMO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_DEMO_API_KEY;
    let failure;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_last_updated_at=true',
          { headers, signal: AbortSignal.timeout(8_000) }
        );
        if (!response.ok) throw new Error(providerError(response));
        const payload = await response.json();
        if (!Number.isFinite(payload?.bitcoin?.usd) || !Number.isFinite(payload?.ethereum?.usd)) {
          throw new Error('CoinGecko returned incomplete Bitcoin or Ethereum prices.');
        }
        const unixToIso = value => Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
        const data = {
          source: 'CoinGecko', currency: 'USD', mode: 'live', retrievedAt: new Date().toISOString(),
          bitcoin: { symbol: 'BTC', price: payload.bitcoin.usd, lastUpdated: unixToIso(payload.bitcoin.last_updated_at) },
          ethereum: { symbol: 'ETH', price: payload.ethereum.usd, lastUpdated: unixToIso(payload.ethereum.last_updated_at) }
        };
        tokenCached = { time: Date.now(), data };
        tokenLastError = undefined;
        return data;
      } catch (error) {
        failure = error;
        if (attempt === 0 && !/rejected the API key/i.test(error.message)) await delay(RETRY_DELAY_MS);
      }
    }
    tokenLastError = failure?.name === 'TimeoutError'
      ? 'CoinGecko price request timed out. Showing the most recent BTC and ETH prices.'
      : failure?.message === 'fetch failed'
        ? 'Cannot connect to CoinGecko. Showing the most recent BTC and ETH prices.'
        : failure?.message || 'Bitcoin and Ethereum prices are temporarily unavailable.';
    tokenRetryAfter = Date.now() + 10_000;
    return tokenCached ? { ...tokenCached.data, mode: 'stale', notice: tokenLastError } : unavailable(tokenLastError);
  })();
  try { return await tokenPending; } finally { tokenPending = null; }
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://coin-images.coingecko.com https://assets.coingecko.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const route = new URL(req.url, 'https://market-atlas.invalid').pathname;
  if (route === '/api/markets') {
    const data = await marketData();
    res.writeHead(data.mode === 'unavailable' ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? '' : JSON.stringify(data));
  }
  if (route === '/token') {
    const data = await tokenData();
    const available = Number.isFinite(data.bitcoin?.price) && Number.isFinite(data.ethereum?.price);
    const body = available ? data : { error: data.error || 'Bitcoin or Ethereum price is currently unavailable.', source: 'CoinGecko' };
    if (available && req.method === 'GET') {
      console.log('Bitcoin (BTC) price in USD:', body.bitcoin.price);
      console.log('Ethereum (ETH) price in USD:', body.ethereum.price);
    }
    res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? '' : JSON.stringify(body));
  }

  const files = {
    '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'],
    '/app.js': ['app.js', 'text/javascript'], '/chart-hints.js': ['chart-hints.js', 'text/javascript'],
    '/brand.svg': ['brand.svg', 'image/svg+xml'], '/logo-unavailable.svg': ['logo-unavailable.svg', 'image/svg+xml']
  };
  if (!files[route]) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Not found' })); }
  const [file, type] = files[route];
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  return res.end(req.method === 'HEAD' ? '' : fs.readFileSync(path.join(publicDir, file)));
}

module.exports = handler;
