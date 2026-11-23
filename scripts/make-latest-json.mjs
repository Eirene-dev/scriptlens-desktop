/**
 * latest.json — what the app reads at start (releases/latest/download/latest.json) to say a newer version is out.
 *
 *   node scripts/make-latest-json.mjs [--out out] [--notes "이번 판에서 바뀐 것"]
 *
 * The version is package.json's. Upload it to the release LAST, after the installers: the app opens `page`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const OUT = resolve(ROOT, argOf('out', 'out'), 'dist');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const REPO = 'https://github.com/Eirene-dev/scriptlens-desktop';
const tag = `v${version}`;
const latest = {
  version,
  released: new Date().toISOString().slice(0, 10),
  page: `${REPO}/releases/tag/${tag}`,
  notes: argOf('notes', ''),
  files: {
    'mac-arm64': `${REPO}/releases/download/${tag}/ScriptLens-mac-arm64.dmg`,
    'mac-x64': `${REPO}/releases/download/${tag}/ScriptLens-mac-x64.dmg`,
    'win-x64': `${REPO}/releases/download/${tag}/ScriptLens-win-x64-setup.exe`,
  },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'latest.json'), `${JSON.stringify(latest, null, 1)}\n`);
process.stdout.write(`${JSON.stringify(latest, null, 1)}\n`);
