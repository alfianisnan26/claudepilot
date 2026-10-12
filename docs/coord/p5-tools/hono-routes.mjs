import { Hono } from '/workspaces/claudepilot/node_modules/hono/dist/index.js';
const sub = new Hono();
sub.use(async (c, next) => { await next(); });           // a group middleware, as requireSession is
sub.get('/', (c) => c.text('list'));
sub.get('/:id', (c) => c.text('one'));
sub.post('/:id/end', (c) => c.text('end'));
sub.all('/x/*', (c) => c.text('wild'));
const app = new Hono();
app.use('/api/*', async (c, next) => {
  const m = c.req.matchedRoutes;
  console.log('MW', c.req.method, c.req.path, 'matchedRoutes:', m.map((r) => `${r.method} ${r.path}`).join(' | '));
  await next();
});
app.route('/api/chat/sessions', sub);
app.get('/healthz', (c) => c.text('ok'));
console.log('app.routes:');
for (const r of app.routes) console.log(' ', r.method.padEnd(6), r.path);
await app.request('/api/chat/sessions/abc');
await app.request('/api/chat/sessions/abc/end', { method: 'POST' });
await app.request('/api/chat/sessions/');
const r = await app.request('/api/nope');
console.log('status for unknown /api path:', r.status);
