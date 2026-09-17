// Run: node --env-file=.env call-output.cjs
// Fetches data and prints it only; received content is never executed.
async function main() {
  const base = process.env.API_BASE_URL;
  const password = process.env.OUTPUT_ACCESS_PASSWORD;
  if (!base || !password) throw new Error('Set API_BASE_URL and OUTPUT_ACCESS_PASSWORD.');
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or HTTP on localhost for local development.');
  }
  const response = await fetch(new URL('/token', url), {
    headers: { Authorization: 'Bearer ' + password },
    signal: AbortSignal.timeout(25000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error('Token request failed (' + response.status + '): ' + await response.text());
  const data = await response.json();
  if (!data.val) throw new Error('Token response is missing val.');
  // Immediately consume the grant before displaying prices or performing other work.
  const output = await fetch(new URL('/output?format=text', url), {
    headers: { Authorization: 'Bearer ' + data.val },
    signal: AbortSignal.timeout(10000),
    redirect: 'error'
  });
  const body = await output.text();
  console.log('Bitcoin (USD):', data.bitcoin?.price);
  console.log('Ethereum (USD):', data.ethereum?.price);
  if (!output.ok) throw new Error('Output request failed (' + output.status + '): ' + body);
  console.log(body);
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
