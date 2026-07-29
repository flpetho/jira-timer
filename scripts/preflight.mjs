/**
 * Runs automatically before `npm run dev` (see the "predev" script).
 *
 * Catches the three things that most often go wrong on a fresh clone and says
 * what to do about each, instead of letting them surface as a stack trace or a
 * mysteriously empty screen. Deliberately dependency-free.
 *
 * Not wired into `npm run build`, so the launchd production path is untouched.
 */
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [18, 17, 0];
const DEFAULT_PORT = 4100;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function fail(title, ...lines) {
  console.error(`\n${red('✗')} ${bold(title)}`);
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

function note(mark, title, ...lines) {
  console.log(`${mark} ${title}`);
  for (const l of lines) console.log(`  ${l}`);
}

/** Compare two [major, minor, patch] tuples. */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

// 1. Node version. next@14 needs >= 18.17.
const current = process.versions.node.split('.').map(Number);
if (compare(current, MIN_NODE) < 0) {
  fail(
    `Node ${process.versions.node} is too old — this needs ${MIN_NODE.join('.')} or newer.`,
    `Install a newer Node from https://nodejs.org, or with nvm:`,
    dim('  nvm install 20 && nvm use 20'),
  );
}

// 2. .env.local. Created from the example so the app can boot; the setup screen
// in the browser then walks through filling it in.
const envLocal = join(root, '.env.local');
const envExample = join(root, '.env.example');
if (!existsSync(envLocal)) {
  if (!existsSync(envExample)) {
    fail(
      'No .env.local and no .env.example to copy from.',
      'Something is missing from this checkout — try a fresh `git clone`.',
    );
  }
  copyFileSync(envExample, envLocal);
  note(
    green('✓'),
    `Created ${bold('.env.local')} from .env.example.`,
    dim('The app will open on a setup screen that walks you through filling it in.'),
  );
} else {
  // Warn when it exists but is still all placeholders — the app will start and
  // show the setup screen, so this is informational rather than fatal.
  const body = readFileSync(envLocal, 'utf8');
  if (/JIRA_API_TOKEN=\s*(paste-your-token-here)?\s*$/m.test(body)) {
    note(
      yellow('!'),
      `${bold('.env.local')} has no API token yet.`,
      dim('The setup screen in the browser has a link and copy-paste block for it.'),
    );
  }
}

// 3. Port. Informational: the author runs an always-on instance on 4100, and a
// second one on another port is a perfectly normal thing to want.
try {
  const pids = execSync(`lsof -ti tcp:${DEFAULT_PORT}`, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  if (pids) {
    const first = pids.split('\n')[0];
    let who = '';
    try {
      who = execSync(`ps -p ${first} -o comm=`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      /* process vanished between calls */
    }
    note(
      yellow('!'),
      `Port ${DEFAULT_PORT} is already in use${who ? ` by ${who}` : ''} (pid ${first}).`,
      `If that's another copy of the timer, start this one elsewhere:`,
      dim(`  npm run dev -- -p 4101`),
    );
  }
} catch {
  // lsof found nothing (exit 1) or isn't available — either way, carry on.
}
