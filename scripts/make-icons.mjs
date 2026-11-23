// build/icon.svg → build/icon.png (1024, for electron-builder's Windows icon) and build/icon.icns (Mac, via iconutil).
//   npx electron scripts/make-icons.mjs
// Electron renders the SVG; no image tool is needed beyond macOS's iconutil.
import { app, BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const svg = readFileSync(join(BUILD, 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  app.dock?.hide();
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  const html = `<html><body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const full = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  writeFileSync(join(BUILD, 'icon.png'), full.toPNG());
  const set = join(BUILD, 'icon.iconset');
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), full.resize({ width: s, height: s, quality: 'best' }).toPNG());
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), full.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
  }
  const r = spawnSync('iconutil', ['-c', 'icns', set, '-o', join(BUILD, 'icon.icns')], { encoding: 'utf8' });
  rmSync(set, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`iconutil: ${r.stderr}`);
  process.stdout.write('build/icon.png, build/icon.icns\n');
  app.exit(0);
});
