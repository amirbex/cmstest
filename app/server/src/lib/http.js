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
  route(method, pattern, handler, opts = {}) {
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
    this.routes.push({ method, rx, keys, handler, opts });
    return this;
  }

  get(p, h) {
    return this.route('GET', p, h);
  }
  post(p, h, opts) {
    return this.route('POST', p, h, opts);
  }
  put(p, h, opts) {
    return this.route('PUT', p, h, opts);
  }
  patch(p, h, opts) {
    return this.route('PATCH', p, h, opts);
  }
  del(p, h, opts) {
    return this.route('DELETE', p, h, opts);
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
      // static — never intercept /api, or an SPA fallback would swallow a route
      for (const s of url.pathname.startsWith('/api/') ? [] : this.statics) {
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
        let rawBody = null;
        let files = [];
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const limit = r.opts.maxBodyBytes ?? this.maxBodyBytes;
          const parsed = await readBody(req, limit);
          body = parsed.body;
          rawBody = parsed.raw;
          files = parsed.files ?? [];
        }

        const ctx = {
          req,
          res,
          url,
          params,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          rawBody,
          files,
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

/**
 * Binary-safe body reader.
 *
 * Uploads are the reason this cannot simply decode to UTF-8: a single invalid
 * byte sequence silently mangles a video file. So the raw Buffer is always
 * captured (`ctx.rawBody`) and only *parsed* when the content type says the
 * payload is structured.
 */
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
      if (!chunks.length) return resolve({ body: null, raw: null });
      const raw = Buffer.concat(chunks);
      const type = String(req.headers['content-type'] ?? '').toLowerCase();

      if (type.includes('application/json')) {
        try {
          resolve({ body: JSON.parse(raw.toString('utf-8')), raw });
        } catch {
          reject(bad('بدنه‌ی JSON نامعتبر است', 'INVALID_JSON'));
        }
        return;
      }

      if (type.includes('multipart/form-data')) {
        const boundary = /boundary=("?)([^";]+)\1/.exec(type);
        if (!boundary) return reject(bad('مرز multipart پیدا نشد', 'BAD_MULTIPART'));
        const parts = parseMultipart(raw, boundary[2]);
        /* first non-file field wins as `body`; files are exposed as `ctx.files` */
        const fields = {};
        for (const part of parts) {
          if (part.filename) continue;
          fields[part.name] = part.data.toString('utf-8');
        }
        resolve({ body: fields, raw, files: parts.filter((p) => p.filename) });
        return;
      }

      if (type.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(raw.toString('utf-8'));
        resolve({ body: Object.fromEntries(params.entries()), raw });
        return;
      }

      if (type.startsWith('text/') || type.includes('xml') || type === '') {
        resolve({ body: raw.toString('utf-8'), raw });
        return;
      }

      /* binary payload (video, image, audio) — caller reads ctx.rawBody */
      resolve({ body: null, raw });
    });
    req.on('error', reject);
  });
}

/**
 * Minimal multipart/form-data parser.
 *
 * Deliberately small: browsers send well-formed boundaries, and we only need
 * `name`, `filename`, `content-type` and the bytes. Splitting on the boundary
 * Buffer is safe because the boundary is chosen by the client to not appear in
 * the payload.
 */
export function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let index = buffer.indexOf(delimiter);
  while (index !== -1) {
    const start = index + delimiter.length;
    /* "--" right after the delimiter marks the final boundary */
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    const chunk = buffer.slice(start + 2, next - 2); // trim CRLF on both sides
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = chunk.slice(0, headerEnd).toString('utf-8');
      const data = chunk.slice(headerEnd + 4);
      const name = /name="([^"]*)"/.exec(headerText)?.[1] ?? '';
      const filename = /filename="([^"]*)"/.exec(headerText)?.[1] ?? null;
      const contentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? null;
      parts.push({ name, filename, contentType, data });
    }
    index = next;
  }
  return parts;
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
