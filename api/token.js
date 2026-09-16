const { tokenData } = require('../lib/token');
const { jsonEndpoint } = require('../lib/http');
const { issueAccess } = require('../lib/output-access');
const prices = jsonEndpoint(tokenData, data => {
  if (data.bitcoin && data.ethereum) {
    console.log('Bitcoin (BTC) price in USD:', data.bitcoin.price);
    console.log('Ethereum (ETH) price in USD:', data.ethereum.price);
  }
});

module.exports = async function token(req, res) {
  const issuedAt = Date.now();
  const url = new URL(req.url || '/token', 'http://localhost');
  if (url.searchParams.get('purpose') !== 'output') return prices(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(req.method === 'HEAD' ? '' : JSON.stringify({ error: 'Method not allowed' }));
  }
  try {
    const data = issueAccess(req, issuedAt);
    res.statusCode = 200;
    return res.end(JSON.stringify(data));
  } catch (error) {
    res.statusCode = error.status || 500;
    if (res.statusCode === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    return res.end(JSON.stringify({ error: error.status ? error.message : 'Unable to issue output access token.' }));
  }
};
