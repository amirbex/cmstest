/**
 * Minimal, dependency-free HTTP router.
 *
 * A deliberate choice over Express: ~120 lines, no transitive supply chain,
 * native body-size limits, and every handler receives already-parsed JSON plus
 * a typed validation helper. Errors are normalised once, in `handle`.
 */
import http from 'node:http';
import { URL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { logEvent } from './db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (msg, code) => new HttpError(400, msg, code ?? 'BAD_REQUEST');
export const notFound = (msg = 'یافت نشد') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg) => new HttpError(409, msg, 'CONFLICT');

export class App {
  constructor({ maxBodyBytes = 8 * 1024 * 1024 } = {}) {
    this.routes = [];
    this.statics = [];
    this.maxBodyBytes = maxBodyBytes;
    this.events = new Set();
  }

  /** Register a route. `:param` segments are captured into req.params. */
  route(method, pattern, handler) {
    const keys = [];
    /* Order matters: escape regex metacharacters first (a `/` is not one, so it
       survives untouched), then turn `:name` segments into capture groups.
       Escaping `/` before this step would break the `\/:name` match and silently
       leave every parameterised route unregistered. */
    const body = pattern
      .replace(/\/+$/, '')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      });
    const rx = new RegExp(`^${body}/?$`);
    this.routes.push({ method, rx, keys, handler });
    return this;
  }

  get(p, h) {
    return this.route('GET', p, h);
  }
  post(p, h) {
    return this.route('POST', p, h);
  }
  patch(p, h) {
    return this.route('PATCH', p, h);
  }
  del(p, h) {
    return this.route('DELETE', p, h);
  }

  /** Serve a directory under a URL prefix (with path-traversal protection). */
  serve(prefix, dir) {
    this.statics.push({ prefix: prefix.replace(/\/$/, ''), dir: path.resolve(dir) });
    return this;
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    const send = (status, body, headers = {}) => {
      const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(payload);
    };

    try {
      // static
      for (const s of this.statics) {
        if (url.pathname === s.prefix || url.pathname.startsWith(`${s.prefix}/`)) {
          const rel = decodeURIComponent(url.pathname.slice(s.prefix.length)).replace(/^\/+/, '');
          const target = path.resolve(s.dir, rel || 'index.html');
          if (!target.startsWith(s.dir)) throw new HttpError(403, 'دسترسی مجاز نیست', 'FORBIDDEN');
          let file = target;
          try {
            const info = await stat(file);
            if (info.isDirectory()) file = path.join(file, 'index.html');
          } catch {
            /* fall through to SPA fallback below */
          }
          try {
            const data = await readFile(file);
            const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
            const isHashed = /-[A-Za-z0-9_]{8,}\./.test(file);
            res.writeHead(200, {
              'Content-Type': type,
              'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
              'X-Content-Type-Options': 'nosniff',
            });
            res.end(data);
            return;
          } catch {
            if (s.dir.includes('dist') && path.extname(url.pathname) === '') {
              const shell = await readFile(path.join(s.dir, 'index.html'));
              res.writeHead(200, { 'Content-Type': MIME['.html'] });
              res.end(shell);
              return;
            }
            throw notFound('فایل پیدا نشد');
          }
        }
      }

      // routes
      for (const r of this.routes) {
        if (r.method !== req.method) continue;
        const m = r.rx.exec(url.pathname);
        if (!m) continue;

        const params = {};
        r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });

        let body = null;
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          body = await readBody(req, this.maxBodyBytes);
        }

        const ctx = {
          req,
          res,
          url,
          params,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          json: (status, payload) => send(status, payload),
          text: (status, payload) => send(status, payload),
          stream: (status, headers) => {
            res.writeHead(status, headers);
            return res;
          },
          onEvent: (fn) => {
            this.events.add(fn);
            return () => this.events.delete(fn);
          },
        };

        const result = await r.handler(ctx);
        if (result !== undefined && !res.headersSent) send(200, result);
        const ms = Date.now() - started;
        if (ms > 1500) logEvent('WARN', 'slow-route', `${req.method} ${url.pathname} took ${ms}ms`);
        return;
      }

      throw notFound('مسیر پیدا نشد');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      /* Internal failure text can carry file paths and SQL fragments, so it is
         never returned to the client — the full stack goes to the log instead.
         Set ATOZ_DEBUG=1 while developing to opt back in. */
      const message =
        err instanceof HttpError
          ? err.message
          : process.env.ATOZ_DEBUG === '1'
            ? (err?.message ?? 'خطای ناشناخته')
            : 'خطای داخلی سرور — جزئیات در گزارش رویدادها ثبت شد';
      if (status >= 500) logEvent('ERROR', 'http', `${req.method} ${url.pathname} → ${err?.stack ?? err}`);
      if (!res.headersSent) {
        send(status, { success: false, error: message, code: err?.code ?? 'ERROR' });
      } else {
        res.end();
      }
    }
  }

  emit(event, payload) {
    for (const fn of this.events) {
      try {
        fn(event, payload);
      } catch {
        /* a dead subscriber must never break a request */
      }
    }
  }

  listen(port, host = '0.0.0.0') {
    const server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'حجم درخواست بیش از حد مجاز است', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf-8');
      const type = req.headers['content-type'] ?? '';
      if (type.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(bad('بدنه‌ی JSON نامعتبر است', 'INVALID_JSON'));
        }
      } else {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

/** Validate with a zod schema and throw a readable Persian 400 on failure. */
export function validate(schema, value, label = 'ورودی') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.join('.') || label;
    throw bad(`${label} نامعتبر است — ${where}: ${first?.message ?? 'مقدار نامشخص'}`, 'VALIDATION');
  }
  return parsed.data;
}
