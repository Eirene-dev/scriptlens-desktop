/**
 * The Mac files to hand out: ScriptLens.app built for Apple silicon and Intel (package-mac.mjs), each packed as a .dmg
 * (the app and a link to /Applications) and a .zip (ditto, as Finder makes one), with SHA-256 sums.
 *
 *   node scripts/dist-mac.mjs [--out out] [--arch arm64|x64]   (both by default)
 *
 * The names carry no version — ScriptLens-mac-arm64.dmg — so the links in lab's page
 * (…/releases/latest/download/ScriptLens-mac-arm64.dmg) stay the same from release to release. Nothing is uploaded.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const OUT = resolve(ROOT, argOf('out', 'out'));
const ARCHS = argOf('arch', null) ? [argOf('arch')] : ['arm64', 'x64'];
const DIST = join(OUT, 'dist');
mkdirSync(DIST, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const files = [];
let version = null;
for (const arch of ARCHS) {
  const built = JSON.parse(run(process.execPath, [join(ROOT, 'scripts', 'package-mac.mjs'), '--arch', arch, '--out', OUT]));
  version = built.version;
  const app = built.app;
  const base = `ScriptLens-mac-${arch}`;

  const zip = join(DIST, `${base}.zip`);
  rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

  const stage = join(OUT, `dmg-stage-${arch}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run('ditto', [app, join(stage, 'ScriptLens.app')]);
  symlinkSync('/Applications', join(stage, 'Applications'));
  const dmg = join(DIST, `${base}.dmg`);
  rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-quiet', '-volname', `ScriptLens ${version}`, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
  rmSync(stage, { recursive: true, force: true });

  for (const f of [dmg, zip]) files.push({ name: f.slice(DIST.length + 1), arch, bytes: statSync(f).size, sha256: sha256(f) });
}
writeFileSync(join(DIST, 'SHA256SUMS-mac.txt'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
const report = { version, signing: 'ad-hoc', notarized: false, files };
writeFileSync(join(DIST, `mac-${version}.json`), `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
