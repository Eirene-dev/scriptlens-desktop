// Rules the main process applies: which URL the window may show, who may use the bridge, what input it takes,
// what an update file may say. Pure functions — no Electron import, so the tests run them as they are.

import { DEFAULT_LAB_URL, LAB_PATH, REPO } from './config.mjs';

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** YouTube caption language codes: en, ko, fil, zh-Hans, pt-BR, es-419, sr-Latn … */
export const LANG_CODE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The lab page to show. `--lab-url=` or SCRIPTLENS_URL for development. A packaged app takes only a local
 * http address besides the real one — so nobody can point the bridge at another site by an argument.
 */
export function resolveLabUrl({ argv = [], env = {}, isPackaged = false } = {}) {
  const fallback = new URL(DEFAULT_LAB_URL);
  const arg = argv.find((a) => a.startsWith('--lab-url='));
  const raw = arg ? arg.slice('--lab-url='.length) : env.SCRIPTLENS_URL || '';
  if (!raw) return fallback;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return fallback;
  }
  const local = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  const https = u.protocol === 'https:';
  if (!(local || (https && (!isPackaged || u.origin === fallback.origin)))) return fallback;
  if (!underLabPath(u.pathname)) u.pathname = LAB_PATH;
  u.hash = '';
  return u;
}

const underLabPath = (pathname) => pathname === LAB_PATH || pathname.startsWith(`${LAB_PATH}/`);

/**
 * What the main window does with a URL it is asked to go to.
 *   'allow'    — the lab's ScriptLens (same origin, under /scriptlens)
 *   'external' — any other web or mail address: the default browser opens it
 *   'block'    — anything else (file:, javascript:, data: …)
 */
export function navigationVerdict(target, lab) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return 'block';
  }
  if (u.origin === lab.origin && underLabPath(u.pathname)) return 'allow';
  if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') return 'external';
  return 'block';
}

/** the bridge answers only the lab's ScriptLens page in the main frame */
export const bridgeAllowed = (frameUrl, lab) => navigationVerdict(frameUrl, lab) === 'allow';

/** { language_code, is_generated } from the page, checked; null if it is not that */
export function readTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const { language_code: code, is_generated: asr } = track;
  if (typeof code !== 'string' || !LANG_CODE_RE.test(code) || typeof asr !== 'boolean') return null;
  return { language_code: code, is_generated: asr };
}

/** 1.2.3 against 1.10.0 → -1 · 0 · 1; anything after "-" or "+" is ignored */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v)
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const RELEASE_PREFIX = `https://github.com/${REPO}/`;

/**
 * latest.json → what to tell the person. The page opened is always this repository's (anything else in the file is
 * ignored), so a wrong file can never send them elsewhere.
 */
export function readLatest(json, currentVersion) {
  if (!json || typeof json !== 'object' || typeof json.version !== 'string' || !/^\d+\.\d+\.\d+/.test(json.version)) return null;
  const page = typeof json.page === 'string' && json.page.startsWith(RELEASE_PREFIX) ? json.page : `${RELEASE_PREFIX}releases/latest`;
  const notes = typeof json.notes === 'string' ? json.notes.slice(0, 600) : '';
  return { version: json.version, newer: compareVersions(json.version, currentVersion) > 0, page, notes };
}
