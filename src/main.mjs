/**
 * ScriptLens desktop — the main process.
 *
 * The window shows https://lab.mindvest.ai/scriptlens (the web page itself: its changes ship with the web deploy). The
 * app adds one thing, the bridge window.scriptlensNative (preload.cjs), whose captions come from a hidden YouTube page
 * (captions/fetcher.mjs). The window stays under /scriptlens of the lab; any other link opens in the default browser.
 *
 *   electron .                                   the app
 *   electron . --lab-url=http://127.0.0.1:3457/scriptlens   another lab (a local one; a packaged app takes only local)
 *   electron . --smoke-test=<dir>                open, wait for the page, write <dir>/smoke.json and smoke.png, quit
 *   electron . --selftest=<id>[:<lang>[:asr]]    (development only) the fetcher without the window — JSON on stdout
 *                                                (lang "auto": the video's first track)
 */
import { app, BrowserWindow, Menu, ipcMain, session, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_NAME, LAB_PARTITION, RELEASES_PAGE, YT_PARTITION } from './config.mjs';
import { bridgeAllowed, navigationVerdict, readTrack, resolveLabUrl } from './policy.mjs';
import { CaptionFetcher } from './captions/fetcher.mjs';
import { fail } from './captions/classify.mjs';
import { checkForUpdate } from './update.mjs';
import { createLog } from './log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name) => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? null : a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
};

// app.isPackaged looks at the executable's name, and the Mac build keeps Electron's (as praxis-desktop's does) — so ask
// where the app's files are: a built app runs from <resources>/app. Development-only switches are off in a built app.
const PACKAGED = app.isPackaged || resolve(app.getAppPath()).startsWith(resolve(process.resourcesPath));

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const LAB = resolveLabUrl({ argv: process.argv, env: process.env, isPackaged: PACKAGED });
const SMOKE = argOf('smoke-test');
const SELFTEST = PACKAGED ? null : argOf('selftest');
const log = createLog(app.getPath('logs'), { echo: !PACKAGED && !SELFTEST });

let mainWindow = null;
let fetcher = null;

// development only: SCRIPTLENS_NO_EXTERNAL=1 logs the address instead of opening the browser (for the UI tests)
const NO_EXTERNAL = !PACKAGED && process.env.SCRIPTLENS_NO_EXTERNAL === '1';
const openExternal = (url) => {
  if (navigationVerdict(url, LAB) === 'block') return;
  log('external', { url: NO_EXTERNAL ? url : new URL(url).origin });
  if (!NO_EXTERNAL) shell.openExternal(url).catch(() => {});
};

function showOffline(wc, reason) {
  log('offline', { reason });
  wc.loadFile(join(HERE, 'offline.html'), { query: { url: LAB.href, reason: String(reason).slice(0, 200) } }).catch(() => {});
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 900,
    minWidth: 480,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: LAB_PARTITION,
      spellcheck: false,
      additionalArguments: [`--scriptlens-origin=${LAB.origin}`, `--scriptlens-app-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => win.show());
  // the window is "ScriptLens" whatever the page calls itself (the taskbar, Alt+Tab and the title bar show it)
  win.on('page-title-updated', (e) => e.preventDefault());
  const wc = win.webContents;

  // no new windows: links that ask for one open in the default browser
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  // the window stays under the lab's /scriptlens
  wc.on('will-navigate', (e, url) => {
    const v = navigationVerdict(url, LAB);
    if (v === 'allow') return;
    e.preventDefault();
    if (v === 'external') openExternal(url);
  });
  wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    if (!isMainFrame || navigationVerdict(url, LAB) === 'allow') return;
    e.preventDefault();
    openExternal(url);
  });
  // client-side navigation (Next.js links) leaves no will-navigate: undo it and open the address outside
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame || navigationVerdict(url, LAB) === 'allow') return;
    openExternal(url);
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else wc.loadURL(LAB.href);
  });
  // offline, or the lab cannot be reached
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !url.startsWith(LAB.origin)) return;
    showOffline(wc, `${desc} (${code})`);
  });
  wc.on('did-navigate', (_e, url, httpCode) => {
    if (httpCode >= 500 && url.startsWith(LAB.origin)) showOffline(wc, `HTTP ${httpCode}`);
  });
  wc.on('render-process-gone', (_e, d) => {
    log('renderer-gone', { reason: d.reason });
    if (!win.isDestroyed()) wc.loadURL(LAB.href).catch(() => {});
  });

  win.on('closed', () => {
    mainWindow = null;
    fetcher?.dispose();
    app.quit();
  });
  wc.loadURL(LAB.href).catch(() => {}); // a failure lands in did-fail-load
  return win;
}

function registerBridge() {
  const senderOk = (e) =>
    !!mainWindow &&
    e.sender === mainWindow.webContents &&
    e.senderFrame === e.sender.mainFrame &&
    bridgeAllowed(e.senderFrame.url, LAB);
  ipcMain.handle('scriptlens:listTracks', (e, videoId) => {
    if (!senderOk(e)) return fail('not_here');
    return fetcher.listTracks(videoId);
  });
  ipcMain.handle('scriptlens:getTranscript', (e, videoId, track) => {
    if (!senderOk(e)) return fail('not_here');
    const t = readTrack(track);
    if (!t) return fail('bad_request');
    return fetcher.getTranscript(videoId, t);
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const help = [
    { label: '새 버전 확인…', click: () => checkForUpdate({ window: mainWindow, currentVersion: app.getVersion(), interactive: true, log }) },
    { label: '내려받기 페이지 열기', click: () => shell.openExternal(RELEASES_PAGE) },
    { type: 'separator' },
    { label: `ScriptLens ${app.getVersion()}`, enabled: false },
  ];
  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: 'ScriptLens에 관하여' },
              { type: 'separator' },
              { role: 'hide', label: 'ScriptLens 가리기' },
              { role: 'hideOthers', label: '기타 가리기' },
              { role: 'unhide', label: '모두 보기' },
              { type: 'separator' },
              { role: 'quit', label: 'ScriptLens 종료' },
            ],
          },
        ]
      : [{ label: '파일', submenu: [{ role: 'quit', label: '종료' }] }]),
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '오려두기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로고침' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        ...(PACKAGED ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    ...(isMac ? [{ role: 'windowMenu', label: '윈도우' }] : []),
    { role: 'help', label: '도움말', submenu: help },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function lockDownLabSession() {
  const ses = session.fromPartition(LAB_PARTITION);
  // the page copies to the clipboard (편집기의 복사); nothing else is granted
  const granted = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(granted.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => granted.has(permission));
}

/** --smoke-test=<dir>: the window opens and shows a page; write what it shows and quit (exit 0 = shown) */
function runSmoke(win) {
  const dir = resolve(SMOKE || '.');
  mkdirSync(dir, { recursive: true });
  const finish = (result, code) => {
    writeFileSync(join(dir, 'smoke.json'), `${JSON.stringify(result, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.exit(code);
  };
  const timer = setTimeout(() => finish({ ok: false, why: 'no page within 60 s' }, 1), 60_000);
  const shoot = async () => {
    await new Promise((r) => setTimeout(r, 2500));
    const wc = win.webContents;
    const img = await wc.capturePage();
    writeFileSync(join(dir, 'smoke.png'), img.toPNG());
    const bridge = await wc.executeJavaScript('typeof window.scriptlensNative').catch(() => 'error');
    clearTimeout(timer);
    finish(
      {
        ok: win.isVisible(),
        version: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
        url: wc.getURL(),
        title: wc.getTitle(),
        windowTitle: win.getTitle(),
        bridge,
        visible: win.isVisible(),
        size: img.getSize(),
      },
      win.isVisible() ? 0 : 1,
    );
  };
  win.webContents.once('did-stop-loading', () => {
    if (win.isVisible()) shoot();
    else win.once('show', shoot);
  });
}

/** --selftest=<id>[:<lang>[:asr]] (development only): listTracks then getTranscript, a summary on stdout */
async function runSelftest(spec) {
  const [id, lang, kind] = spec.split(':');
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const out = { id };
  const tl = await fetcher.listTracks(id);
  out.listTracks = tl.ok ? { ms: ms(), title: tl.data.title, tracks: tl.data.tracks.map((t) => `${t.language_code}${t.is_generated ? ':asr' : ''}`) } : { ms: ms(), ...tl };
  const steps = (lang ? [lang] : []).concat(process.env.SELFTEST_ALSO ? process.env.SELFTEST_ALSO.split(',') : []);
  for (const step of steps) {
    // "auto": the first track the video has
    const first = step === 'auto' && tl.ok ? tl.data.tracks[0] : null;
    const [code, k] = first ? [first.language_code, first.is_generated ? 'asr' : ''] : step.includes(':') ? step.split(':') : [step, kind];
    const t1 = performance.now();
    const r = await fetcher.getTranscript(id, { language_code: code, is_generated: k === 'asr' });
    (out.getTranscript ??= []).push(
      r.ok
        ? { track: `${code}${k === 'asr' ? ':asr' : ''}`, ms: Math.round(performance.now() - t1), source: r.data.source, language: r.data.language, snippets: r.data.snippets.length, first: r.data.snippets.slice(0, 2).map((s) => [s.start, s.duration]) }
        : { track: code, ms: Math.round(performance.now() - t1), ...r },
    );
  }
  out.ms = ms();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  fetcher.dispose();
  app.exit(0);
}

if (!SMOKE && !SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  // nothing opens a window, a webview or a new page on its own
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), copyright: '© MindVest' });
    fetcher = new CaptionFetcher({
      partition: YT_PARTITION,
      log,
      forcePanel: !PACKAGED && process.env.SCRIPTLENS_FORCE_PANEL === '1',
    });
    if (SELFTEST) {
      if (process.platform === 'darwin') app.dock?.hide();
      runSelftest(SELFTEST);
      return;
    }
    lockDownLabSession();
    registerBridge();
    buildMenu();
    log('start', { version: app.getVersion(), lab: LAB.href, packaged: PACKAGED });
    mainWindow = createMainWindow();
    if (SMOKE !== null) {
      runSmoke(mainWindow);
      return;
    }
    // development only: SCRIPTLENS_UPDATE_URL points the check at another latest.json
    const updateUrl = !PACKAGED && process.env.SCRIPTLENS_UPDATE_URL ? process.env.SCRIPTLENS_UPDATE_URL : undefined;
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => checkForUpdate({ window: mainWindow, currentVersion: app.getVersion(), log, url: updateUrl }), 3000);
    });
  });
}
