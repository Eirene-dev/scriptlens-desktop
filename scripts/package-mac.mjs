/**
 * Build ScriptLens.app for one Mac architecture — UNSIGNED (ad-hoc), the way praxis-desktop builds its Mac app
 * (scripts/package-alpha2-mac.ts there): this Electron's Electron.app copied, the app's files in Contents/Resources/app,
 * Info.plist renamed, the Node fuses closed, then an ad-hoc signature (`codesign --sign -`) so Apple silicon runs it.
 * No Apple Developer ID: on another Mac the person opens it once through System Settings › Privacy & Security.
 *
 *   node scripts/package-mac.mjs --arch arm64|x64 [--out out]
 *
 * x64 on an Apple-silicon Mac: Electron's x64 build is fetched with @electron/get (electron's own downloader, cached).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeNodeFuses, nodeFusesClosed, readFuses } from './electron-fuses.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const ARCH = argOf('arch', process.arch);
if (ARCH !== 'arm64' && ARCH !== 'x64') throw new Error('--arch takes arm64 or x64');
const OUT = resolve(ROOT, argOf('out', 'out'));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const ELECTRON_VERSION = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
export const BUNDLE_ID = 'ai.mindvest.scriptlens';
const DIR = join(OUT, `mac-${ARCH}`);
const APP = join(DIR, 'ScriptLens.app');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const archsOf = (app) => run('lipo', ['-archs', join(app, 'Contents', 'MacOS', 'Electron')]).trim().split(/\s+/);
const lipoName = (a) => (a === 'x64' ? 'x86_64' : a);

async function electronApp() {
  const local = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (existsSync(local) && archsOf(local).includes(lipoName(ARCH))) return local;
  const { downloadArtifact } = await import('@electron/get');
  const zip = await downloadArtifact({ version: ELECTRON_VERSION, platform: 'darwin', arch: ARCH, artifactName: 'electron' });
  const into = mkdtempSync(join(tmpdir(), `scriptlens-electron-${ARCH}-`));
  run('ditto', ['-x', '-k', zip, into]);
  const app = join(into, 'Electron.app');
  if (!archsOf(app).includes(lipoName(ARCH))) throw new Error(`the downloaded Electron is not ${ARCH}`);
  return app;
}

const from = await electronApp();
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
run('cp', ['-R', from, APP]); // cp -R keeps the framework's symbolic links

const RES = join(APP, 'Contents', 'Resources');
rmSync(join(RES, 'default_app.asar'), { force: true });
cpSync(join(ROOT, 'src'), join(RES, 'app', 'src'), { recursive: true });
writeFileSync(
  join(RES, 'app', 'package.json'),
  `${JSON.stringify(
    { name: PKG.name, productName: PKG.productName, version: VERSION, private: true, type: 'module', main: 'src/main.mjs', description: PKG.description, author: PKG.author },
    null,
    1,
  )}\n`,
);
cpSync(join(ROOT, 'build', 'icon.icns'), join(RES, 'electron.icns'));

const plist = join(APP, 'Contents', 'Info.plist');
for (const [key, type, value] of [
  ['CFBundleName', 'string', 'ScriptLens'],
  ['CFBundleDisplayName', 'string', 'ScriptLens'],
  ['CFBundleIdentifier', 'string', BUNDLE_ID],
  ['CFBundleShortVersionString', 'string', VERSION],
  ['CFBundleVersion', 'string', VERSION],
  ['NSHumanReadableCopyright', 'string', '© MindVest'],
  ['LSApplicationCategoryType', 'string', 'public.app-category.productivity'],
]) {
  run('plutil', ['-replace', key, `-${type}`, value, plist]);
}

closeNodeFuses(APP); // before the signature: writing the binary breaks the one it had
run('codesign', ['--force', '--deep', '--sign', '-', APP]);
run('codesign', ['--verify', '--deep', '--strict', APP]);
if (!nodeFusesClosed(APP)) throw new Error('the Node fuses are open');

const report = {
  app: APP,
  version: VERSION,
  electron: ELECTRON_VERSION,
  arch: ARCH,
  archs: archsOf(APP),
  bundleId: BUNDLE_ID,
  signing: 'ad-hoc',
  fuses: readFuses(APP).map((w) => w.wire),
  minimumMacOS: run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', plist]).trim(),
};
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
