// Health check for deploys and uptime monitors. Make it fail when the app can't serve,
// e.g. by querying a real table.
export const GET = () => new Response('OK', { headers: { 'cache-control': 'no-store' } });
