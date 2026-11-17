/**
 * HTTP layer tests — routing, validation envelope, static containment.
 *
 * These exist because the typechecker cannot see a route that never registered:
 * a broken `:param` regex makes every parameterised endpoint answer 404 while
 * the app still builds and boots happily.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { App, bad, notFound, validate, HttpError } from '../app/server/src/lib/http.js';
import { z } from 'zod';

const tmpDir = fs.mkdtempSync(path.join('/tmp', 'atoz-http-'));
process.env.ATOZ_DATA_DIR = path.join(tmpDir, 'data');

const { buildApp } = await import('../app/server/src/routes/index.js');

/** Boot the real app on an ephemeral port and return a tiny fetch helper. */
async function boot() {
  const app = buildApp();
  const server = await app.listen(0, '127.0.0.1');
  const port = server.address().port;
  const call = async (pathname, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON (files, SSE) */
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  return { port, call, close: () => new Promise((r) => server.close(r)) };
}

test('router', async (t) => {
  const app = new App();
  app.get('/api/plain', () => ({ ok: 1 }));
  app.get('/api/items/:id', ({ params }) => ({ id: params.id }));
  app.get('/api/items/:id/nested/:sub', ({ params }) => ({ ...params }));
  app.post('/api/items/:id', ({ params, body }) => ({ id: params.id, body }));
  app.get('/api/items', () => ({ list: true }));
  app.get('/api/oops', () => {
    throw notFound('نیست');
  });
  app.get('/api/boom', () => {
    throw new Error('internal detail that must not leak');
  });

  const server = await app.listen(0, '127.0.0.1');
  const port = server.address().port;
  const get = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  await t.test('captures a single parameter (regression: dead :param routes)', async () => {
    const r = await get('/api/items/ATZ-C-000001');
    assert.equal(r.status, 200);
    assert.equal(r.json.id, 'ATZ-C-000001');
  });

  await t.test('captures several parameters in order', async () => {
    const r = await get('/api/items/abc/nested/xyz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { id: 'abc', sub: 'xyz' });
  });

  await t.test('does not confuse /items with /items/:id', async () => {
    assert.equal((await get('/api/items')).json.list, true);
  });

  await t.test('url-decodes parameters', async () => {
    const r = await get('/api/items/%D8%B3%D9%84%D8%A7%D9%85');
    assert.equal(r.json.id, 'سلام');
  });

  await t.test('a parameter never matches across a slash', async () => {
    const r = await get('/api/items/a/b/c');
    assert.equal(r.status, 404);
  });

  await t.test('trailing slash is optional', async () => {
    assert.equal((await get('/api/plain/')).status, 200);
  });

  await t.test('POST body is parsed as JSON', async () => {
    const r = await get('/api/items/x1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'دنیا' }),
    });
    assert.equal(r.json.body.hello, 'دنیا');
  });

  await t.test('HttpError keeps its status and Persian message', async () => {
    const r = await get('/api/oops');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'نیست');
    assert.equal(r.json.success, false);
  });

  await t.test('unexpected errors are masked, not echoed', async () => {
    const r = await get('/api/boom');
    assert.equal(r.status, 500);
    assert.ok(!r.json.error.includes('internal detail'), 'stack detail leaked to the client');
  });

  await t.test('validate() reports the offending path', () => {
    const schema = z.object({ n: z.number() });
    try {
      validate(schema, { n: 'x' }, 'ورودی');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.ok(err.message.includes('n'));
    }
  });

  await t.test('bad() defaults to a 400 with a code', () => {
    const err = bad('نامعتبر');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'BAD_REQUEST');
  });

  await new Promise((r) => server.close(r));
});

test('live app', async (t) => {
  const app = await boot();
  t.after(() => app.close());

  await t.test('health responds', async () => {
    const r = await app.call('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.ok, true);
  });

  await t.test('every documented room endpoint answers, not 404s', async () => {
    const paths = [
      '/api/state',
      '/api/brand',
      '/api/brand/theme/Magazine',
      '/api/motions',
      '/api/contents',
      '/api/puzzle/blocks',
      '/api/voice/engines',
      '/api/calendar/week',
      '/api/calendar/month',
      '/api/assets',
      '/api/dam',
      '/api/logs',
      '/api/quotas',
      '/api/prompts',
      '/api/render/jobs',
    ];
    for (const p of paths) {
      const r = await app.call(p);
      assert.equal(r.status, 200, `${p} → ${r.status} ${r.text.slice(0, 120)}`);
      assert.equal(r.json.success, true, `${p} did not return the ok envelope`);
    }
  });

  await t.test('an unknown section is a client error, not a silent fallback', async () => {
    const r = await app.call('/api/brand/theme/NotASection');
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'INVALID_SECTION');
  });

  await t.test('a missing content id is 404 with a Persian message', async () => {
    const r = await app.call('/api/contents/ATZ-C-999999');
    assert.equal(r.status, 404);
    assert.ok(r.json.error.includes('پیدا نشد'));
  });

  await t.test('a malformed body is a validation error', async () => {
    const r = await app.call('/api/puzzle/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'VALIDATION');
  });

  await t.test('an injection-shaped id does not reach the data layer', async () => {
    const r = await app.call(`/api/contents/${encodeURIComponent("ATZ-C-1' OR 1=1--")}`);
    assert.equal(r.status, 404);
    assert.equal(r.json.success, false);
  });

  await t.test('static files cannot escape their root', async () => {
    for (const attempt of ['/media/../../etc/passwd', '/media/%2e%2e/%2e%2e/etc/passwd', '/media/..%2f..%2fetc%2fpasswd']) {
      const r = await app.call(attempt);
      assert.ok(!r.text.includes('root:x:'), `traversal succeeded: ${attempt}`);
    }
  });

  await t.test('security headers are present', async () => {
    const r = await app.call('/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
