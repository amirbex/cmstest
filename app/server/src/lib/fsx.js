/** Small filesystem helpers shared by the queue and asset services. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove render scratch directories older than an hour. */
export async function pruneOldFrames() {
  const dir = path.resolve('storage/outputs/.frames');
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const info = await fsp.stat(full);
      if (info.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
    }
  } catch {
    /* nothing to prune */
  }
}

/** Walk a directory, returning web URLs relative to a served prefix. */
export function walkAssets(rootDir, webPrefix) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, url);
      else {
        const stat = fs.statSync(full);
        out.push({ name: entry.name, url, dir: prefix, bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
  };
  walk(rootDir, webPrefix);
  return out;
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
