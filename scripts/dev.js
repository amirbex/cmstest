#!/usr/bin/env node
/**
 * `npm run dev` — runs the API and the Vite dev server side by side.
 *
 * One command, two processes, one Ctrl-C. Coloured, prefixed output so you can
 * tell which side logged what; if either child dies the other is shut down so
 * you never end up with a half-running studio.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = {
  api: '\x1b[38;5;178m',
  web: '\x1b[38;5;75m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
};

const children = [];
let closing = false;

function run(name, command, args, colour, extraEnv = {}, cwd = ROOT) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  children.push(child);

  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      stream.write(`${colour}${name.padEnd(4)}${C.reset} ${C.dim}│${C.reset} ${line}\n`);
    }
  };
  child.stdout.on('data', write(process.stdout));
  child.stderr.on('data', write(process.stderr));

  child.on('exit', (code, signal) => {
    if (closing) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`${C.red}✕ ${name} exited (${reason}) — shutting down the other process${C.reset}`);
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 400);
}

console.log(`
${C.api}  ▸ AtoZ Content Studio v6${C.reset} ${C.dim}— development${C.reset}
${C.dim}    API  http://localhost:4000${C.reset}
${C.dim}    Web  http://localhost:5173${C.reset}
`);

run('api', process.execPath, ['--experimental-sqlite', 'app/server/src/main.js'], C.api, { NODE_ENV: 'development' });
run(
  'web',
  process.execPath,
  // eslint-disable-next-line no-undef
  [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', '5173', '--strictPort'],
  C.web,
  { NODE_ENV: 'development' },
  /* vite must run from the web workspace so it picks up vite.config.ts + index.html */
  path.join(ROOT, 'app', 'web')
);

process.on('SIGINT', () => {
  console.log(`\n${C.dim}  ■ stopping…${C.reset}`);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
