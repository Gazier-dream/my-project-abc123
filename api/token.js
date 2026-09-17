const { tokenData } = require('../lib/token');
const { jsonEndpoint } = require('../lib/http');
const { authenticateAccess, issueAccess } = require('../lib/output-access');
function logPrices(data) {
  if (data.bitcoin && data.ethereum) {
    console.log('Bitcoin (BTC) price in USD:', data.bitcoin.price);
    console.log('Ethereum (ETH) price in USD:', data.ethereum.price);
  }
}
const prices = jsonEndpoint(tokenData, logPrices);

module.exports = async function token(req, res) {
  const url = new URL(req.url || '/token', 'http://localhost');
  const wantsAccess = req.headers?.authorization !== undefined || url.searchParams.get('purpose') === 'output';
  if (!wantsAccess) return prices(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(req.method === 'HEAD' ? '' : JSON.stringify({ error: 'Method not allowed' }));
  }
  try {
    // Authenticate before making any provider request.
    authenticateAccess(req);
    const data = await tokenData();
    if (data.retryAfterSeconds) res.setHeader('Retry-After', String(data.retryAfterSeconds));
    if (data.mode === 'unavailable') {
      res.statusCode = 503;
      return res.end(JSON.stringify(data));
    }
    logPrices(data);
    // Each response gets a new grant, even when prices came from the cache.
    const access = issueAccess(req, Date.now());
    res.statusCode = 200;
    return res.end(JSON.stringify({ ...data, ...access }));
  } catch (error) {
    res.statusCode = error.status || 500;
    if (res.statusCode === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    return res.end(JSON.stringify({ error: error.status ? error.message : 'Unable to issue output access token.' }));
  }
};
