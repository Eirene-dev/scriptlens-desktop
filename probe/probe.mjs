// Stage 0 probe — does a hidden YouTube page hand us its captions?
//
//   npx electron probe/probe.mjs <videoId...> [--lang=ko] [--asr|--manual] [--method=auto|player|panel]
//                                [--show] [--compare] [--full] [--timeout=30000] [--verbose] [--dump=<dir>] [--gap=ms]
//   npx electron probe/probe.mjs --search="query" [--cc]
//
//   experiments behind STAGE0.md:  --ua=chrome (strip "Electron/x" from the UA)  --early (DevTools protocol from the start)
//                                  --tokenonly (stop once the token is known good)  --toklog=<dir>  --loads=N
//                                  --partition=memory  --offline (a dead proxy: the network error's shape)
//
// The page is the real https://www.youtube.com/watch?v=ID. YouTube's own JS builds the player, its PoToken and the
// caption request; we only read the response bodies through the DevTools protocol (Network.getResponseBody).
// This script makes no request to YouTube itself. --compare asks the old lab API (FastAPI) for the same track —
// Stage 0 only, to check the two agree.
//
// Findings (2026-11-23, STAGE0.md):
//  - Keep Electron's own user agent. With "Electron/x" stripped (a Chrome-looking UA) about half the PoTokens came back
//    refused by /api/timedtext (an empty 200); with Electron's own UA, every one worked. The DevTools protocol being
//    attached made no difference.
//  - The player's first caption request goes out without a token and comes back empty; turning the track off and on
//    makes it ask again with the token it then has.
//  - Auto-generated tracks are listed by the player only with getOption('captions', 'tracklist', { includeAsr: true }).
//  - An ad has captions of its own: the track is never touched while an ad shows, and only a response whose v= is the
//    asked video counts.

import { app, BrowserWindow, session } from 'electron';
import { writeFileSync } from 'node:fs';
import { parseTimedtext, parsePanel } from './parse.mjs';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const rawArgs = process.argv.slice(process.argv.findIndex((a) => a.endsWith('probe.mjs')) + 1);
const flags = Object.fromEntries(
  rawArgs.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const ids = rawArgs.filter((a) => !a.startsWith('-') && ID_RE.test(a));
const TIMEOUT = Number(flags.timeout ?? 30000);
const PARTITION = flags.partition === 'memory' ? 'scriptlens-youtube' : 'persist:scriptlens-youtube';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => flags.verbose && process.stderr.write(`[probe] ${a.join(' ')}\n`);

/** executeJavaScript never settles if the page navigates under it — bound every call */
function evalIn(wc, code, ms = 3000) {
  return Promise.race([wc.executeJavaScript(code), new Promise((_, rej) => setTimeout(() => rej(new Error('eval-timeout')), ms))]);
}

function youtubeSession() {
  const ses = session.fromPartition(PARTITION);
  // Keep Electron's own UA. Stripping "Electron/x" (--ua=chrome) made about half the PoTokens come back refused:
  // the string then disagrees with the rest of the browser.
  if (flags.ua === 'chrome') ses.setUserAgent(ses.getUserAgent().replace(/\s+Electron\/\S+/, '').replace(/\s+scriptlens-desktop\/\S+/i, ''));
  // English for the hidden page: track names as the old API gave them ("Korean (auto-generated)") and error reasons we can read
  else if (flags.lang_header !== 'os') ses.setUserAgent(ses.getUserAgent(), 'en-US,en');
  return ses;
}

function hiddenWindow(show) {
  const win = new BrowserWindow({
    show,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

const kindOf = (u) =>
  u.includes('/api/timedtext')
    ? 'timedtext'
    : u.includes('/youtubei/v1/get_panel') || u.includes('/youtubei/v1/get_transcript')
      ? 'panel'
      : null;

/**
 * One record list, two sources:
 *  - session.webRequest (always on, invisible to the page): status and Content-Length of each caption request
 *  - the DevTools protocol (attached on demand): the response body
 */
function makeRecorder(wc, t0) {
  const recs = [];
  const waiters = new Set();
  const push = (rec) => {
    rec.i = recs.length; // index every record, so "after this point" is cheap
    recs.push(rec);
    log(rec.src, rec.kind, rec.status, rec.src === 'cdp' ? `body ${rec.body.length}` : `len ${rec.len}`, rec.at, potOf(rec)?.slice(0, 6) ?? '-');
    if (flags.dump && rec.src === 'cdp') writeFileSync(`${flags.dump}/${Date.now()}-${rec.kind}.txt`, `${rec.url}\n\n${rec.body}`);
    for (const w of waiters) w(rec);
  };

  wc.session.webRequest.onCompleted({ urls: ['https://www.youtube.com/api/timedtext*'] }, (d) => {
    if (d.webContentsId !== wc.id) return;
    const h = Object.fromEntries(Object.entries(d.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v[0]]));
    if (flags.toklog) writeFileSync(`${flags.toklog}/${Date.now()}-${h['content-length'] ?? 'x'}.url`, d.url); // TOKLOG
    push({ src: 'wr', kind: 'timedtext', url: d.url, status: d.statusCode, len: h['content-length'] == null ? -1 : Number(h['content-length']), at: Math.round(now() - t0) });
  });

  // network-class failures inside this window: a page served from YouTube's service worker can "load" while offline
  const netErrors = [];
  wc.session.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (d) => {
    if (d.webContentsId === wc.id && NET_ERR.test(d.error)) netErrors.push(d.error);
  });

  let cdp = null;
  /** attach the DevTools protocol and enable Network; resolves once bodies can be read */
  const attachCdp = async () => {
    if (cdp) return cdp;
    const dbg = wc.debugger;
    dbg.attach('1.3');
    const pending = new Map();
    dbg.on('message', (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const kind = kindOf(params.response.url);
        if (kind) pending.set(params.requestId, { kind, url: params.response.url, status: params.response.status });
      } else if (method === 'Network.loadingFinished') {
        const p = pending.get(params.requestId);
        if (!p) return;
        pending.delete(params.requestId);
        dbg
          .sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then(({ body, base64Encoded }) =>
            push({ src: 'cdp', ...p, body: base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body, at: Math.round(now() - t0) }),
          )
          .catch(() => {});
      } else if (method === 'Network.loadingFailed') {
        pending.delete(params.requestId);
      }
    });
    cdp = Promise.race([
      dbg.sendCommand('Network.enable', { maxResourceBufferSize: 64e6, maxTotalBufferSize: 256e6 }),
      sleep(5000).then(() => Promise.reject(new Error('Network.enable timeout'))),
    ]);
    await cdp;
    return cdp;
  };

  /** the first record (already in, or arriving) that `pred` accepts, or null after `ms` */
  const waitFor = (pred, ms) =>
    new Promise((resolve) => {
      const hit = recs.find(pred);
      if (hit) return resolve(hit);
      const w = (rec) => {
        if (!pred(rec)) return;
        waiters.delete(w);
        clearTimeout(timer);
        resolve(rec);
      };
      const timer = setTimeout(() => {
        waiters.delete(w);
        resolve(null);
      }, Math.max(0, ms));
      waiters.add(w);
    });

  const close = () => {
    wc.session.webRequest.onCompleted(null);
    wc.session.webRequest.onErrorOccurred(null);
    try {
      if (cdp) wc.debugger.detach();
    } catch {}
  };
  return { recs, waitFor, attachCdp, close, netErrors };
}

const NET_ERR = /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|TIMED_OUT|NETWORK_\w+|ADDRESS_UNREACHABLE|PROXY_\w+|TUNNEL_\w+|SSL_\w+|CERT_\w+|EMPTY_RESPONSE|QUIC_\w+)/;

const potOf = (rec) => {
  try {
    return new URL(rec.url).searchParams.get('pot');
  } catch {
    return null;
  }
};

const READ_INFO = `(() => {
  const r = window.ytInitialPlayerResponse;
  if (!r || !document.getElementById('movie_player')) return null;
  const ps = r.playabilityStatus || {};
  const txt = (o) => !o ? null : (o.simpleText || (o.runs || []).map((x) => x.text).join('') || null);
  const em = ps.errorScreen && (ps.errorScreen.playerErrorMessageRenderer || ps.errorScreen.playerLegacyDesktopYpcOfferRenderer);
  const tl = r.captions && r.captions.playerCaptionsTracklistRenderer;
  const tracks = ((tl && tl.captionTracks) || []).map((t) => ({
    name: txt(t.name) || t.languageCode, languageCode: t.languageCode, kind: t.kind || '', isTranslatable: !!t.isTranslatable,
  }));
  const vd = r.videoDetails || {};
  const panels = JSON.stringify((window.ytInitialData && window.ytInitialData.engagementPanels) || []);
  return {
    status: ps.status || null, reason: ps.reason || null, subreason: em ? txt(em.subreason) : null,
    title: vd.title || null, videoId: vd.videoId || null, lengthSeconds: Number(vd.lengthSeconds || 0),
    isLive: !!vd.isLive, tracks, hasTranscriptPanel: panels.includes('engagement-panel-searchable-transcript'),
  };
})()`;

const PLAYER_STATE = `(() => {
  const p = document.getElementById('movie_player');
  if (!p) return null;
  const v = document.querySelector('#movie_player video');
  return {
    ad: p.classList.contains('ad-showing'),
    state: typeof p.getPlayerState === 'function' ? p.getPlayerState() : null,
    t: v ? Math.round(v.currentTime * 10) / 10 : null, dur: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    skip: !!document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button'),
  };
})()`;

function turnOnTrack(videoId, lang, asr) {
  return `(() => {
    const p = document.getElementById('movie_player');
    if (!p || typeof p.getOption !== 'function') return { ok: false, why: 'no-player-api' };
    try { p.mute(); } catch (e) {}
    // an ad has its own captions: never touch the track while one plays, nor when the player holds another video
    if (p.classList.contains('ad-showing')) return { ok: false, why: 'ad', ad: true };
    const vd = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
    if (!vd || vd.video_id !== ${JSON.stringify(videoId)}) return { ok: false, why: 'other-video', got: vd && vd.video_id };
    try { p.loadModule('captions'); } catch (e) {}
    let list = [];
    // auto-generated tracks are listed only with includeAsr
    try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (e) {}
    const t = list.find((x) => x.languageCode === ${JSON.stringify(lang)} && ((x.kind === 'asr') === ${asr}));
    if (!t) return { ok: false, why: 'track-not-in-player', n: list.length };
    p.setOption('captions', 'track', t);
    return { ok: true };
  })()`;
}

/** off and on again: the player asks /api/timedtext once more (with its PoToken, once it has one) */
const RETOGGLE = `(() => {
  const p = document.getElementById('movie_player');
  if (p.classList.contains('ad-showing')) return false;
  const t = p.getOption('captions', 'track');
  p.setOption('captions', 'track', {});
  p.unloadModule('captions');
  p.loadModule('captions');
  p.setOption('captions', 'track', t);
  return !!(t && t.languageCode);
})()`;

const OPEN_PANEL = `(() => {
  const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
  if (btn) { btn.click(); return 'button'; }
  const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
  if (panel) { panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); return 'attribute'; }
  return null;
})()`;

function classify(info) {
  const s = info.status;
  if (s === 'OK') return null;
  const r = `${info.reason ?? ''} ${info.subreason ?? ''}`;
  if (/confirm your age|age-restricted|inappropriate for some users/i.test(r) || /^AGE_/.test(s ?? '')) return 'login_required';
  if (/not a bot/i.test(r)) return 'login_required';
  if (/private/i.test(r)) return 'unavailable';
  if (s === 'LOGIN_REQUIRED' || s === 'CONTENT_CHECK_REQUIRED') return 'login_required';
  return 'unavailable';
}

const toTracks = (raw) =>
  raw.map((t) => ({ language: t.name, language_code: t.languageCode, is_generated: t.kind === 'asr', is_translatable: t.isTranslatable }));

function pickTrack(tracks, lang, asr) {
  if (lang) {
    const same = tracks.filter((t) => t.language_code === lang);
    if (asr !== undefined) return same.find((t) => t.is_generated === asr) ?? null;
    return same.find((t) => !t.is_generated) ?? same[0] ?? null;
  }
  // page.tsx's default: ko manual → en manual → first
  return tracks.find((t) => t.language_code === 'ko' && !t.is_generated) ?? tracks.find((t) => t.language_code === 'en' && !t.is_generated) ?? tracks[0] ?? null;
}

async function readInfo(wc, left, loadErr) {
  while (left() > 0 && !loadErr()) {
    await sleep(150);
    const info = await evalIn(wc, READ_INFO).catch(() => null);
    if (info) return info;
  }
  return null;
}

/**
 * 1순위: the player turns the track on and fetches /api/timedtext itself.
 * → { ok: true, snippets, at, fmt } | { ok: false, why: 'token-refused' | 'no-request' | 'ad' | 'not-offered' | 'no-body' }
 */
async function viaPlayer(wc, rec, videoId, pick, stopAt, rep) {
  const want = (r) => {
    if (r.kind !== 'timedtext' || r.i < rep.base) return false;
    const q = new URL(r.url).searchParams;
    return q.get('v') === videoId && q.get('lang') === pick.language_code && (q.get('kind') === 'asr') === pick.is_generated && !q.get('tlang');
  };
  // wait until the content player offers the track (an ad in front keeps the list empty)
  let on = null;
  while (now() < stopAt) {
    const st = await evalIn(wc, PLAYER_STATE).catch(() => null);
    if (st?.ad) {
      rep.ad ??= { first_ms: Math.round(now() - rep.t0), samples: [] };
      if (rep.ad.samples.length < 40) rep.ad.samples.push([Math.round(now() - rep.t0), st.t, st.dur, st.skip ? 'skip' : '']);
    }
    on = await evalIn(wc, turnOnTrack(rep.videoId, pick.language_code, pick.is_generated)).catch(() => null);
    if (on?.ok) break;
    await sleep(300);
  }
  if (rep.ad) rep.ad.ended_ms = on?.ok ? Math.round(now() - rep.t0) : null;
  if (!on?.ok) return { ok: false, why: rep.ad ? 'ad' : 'not-offered' };
  rep.track_on_ms = Math.round(now() - rep.t0);
  rep.toggles = 0;

  // a. through webRequest only: wait for a request that carries the PoToken and came back with content
  let seen = rep.base;
  let tokenOk = false;
  while (!tokenOk) {
    const from = seen;
    const r = await rec.waitFor((x) => x.src === 'wr' && want(x) && x.i >= from, Math.min(5000, stopAt - now()));
    if (!r) return { ok: false, why: 'no-request' };
    seen = r.i + 1;
    const pot = potOf(r);
    (rep.requests ??= []).push({ src: 'wr', pot: pot?.slice(0, 6) ?? null, len: r.len, at: r.at });
    if (pot && r.len !== 0) tokenOk = true;
    else if (pot) return { ok: false, why: 'token-refused' };
    else {
      if (now() + 1500 > stopAt) return { ok: false, why: 'no-request' };
      await sleep(700); // no token yet: the player mints one after this first, empty answer
      await evalIn(wc, RETOGGLE).catch(() => null);
      rep.toggles++;
    }
  }

  if (flags.tokenonly) return { ok: true, snippets: [], at: rep.requests.at(-1).at, fmt: 'token-only' };
  // b. now the protocol: ask once more (same token), read the body
  for (let tries = 0; tries < 2 && now() < stopAt; tries++) {
    const t = now();
    await rec.attachCdp();
    rep.cdp_attach_ms ??= Math.round(now() - t);
    const from = rec.recs.length;
    await evalIn(wc, RETOGGLE).catch(() => null);
    rep.toggles++;
    const r = await rec.waitFor((x) => x.src === 'cdp' && want(x) && x.i >= from, Math.min(5000, stopAt - now()));
    if (!r) continue;
    const pot = potOf(r);
    (rep.requests ??= []).push({ src: 'cdp', pot: pot?.slice(0, 6) ?? null, len: r.body.length, at: r.at });
    const snippets = parseTimedtext(r.body);
    if (snippets.length) return { ok: true, snippets, at: r.at, fmt: new URL(r.url).searchParams.get('fmt') };
    return { ok: false, why: pot ? 'token-refused' : 'no-body' };
  }
  return { ok: false, why: 'no-body' };
}

async function probe(videoId, opts) {
  const t0 = now();
  const deadline = t0 + TIMEOUT;
  const left = () => deadline - now();
  const out = { video_id: videoId, ok: false, timing: {} };
  const win = hiddenWindow(!!opts.show);
  const wc = win.webContents;
  let rec = null;
  try {
    await wc.loadURL('about:blank');
    rec = makeRecorder(wc, t0);
    if (flags.early) await rec.attachCdp();

    const method = opts.method ?? 'auto';
    let info = null;
    let pick = null;
    const maxLoads = Number(flags.loads ?? 2);
    for (let load = 1; load <= maxLoads; load++) {
      out.loads = load;
      const base = rec.recs.length; // an earlier load's answers are not this load's
      let loadError = null;
      wc.loadURL(`https://www.youtube.com/watch?v=${videoId}&hl=en`).catch((e) => {
        if (e && e.code !== 'ERR_ABORTED') loadError = e;
      });
      info = await readInfo(wc, left, () => loadError || (rec.netErrors.length >= 3 && now() - t0 > 4000));
      if (loadError) {
        out.error = { code: NET_ERR.test(String(loadError.code)) ? 'network' : 'timeout', detail: String(loadError.code ?? loadError.message) };
        return out;
      }
      if (!info) {
        out.error = rec.netErrors.length
          ? { code: 'network', detail: [...new Set(rec.netErrors)].slice(0, 3).join(' ') }
          : { code: 'timeout', detail: 'the page never produced a player response' };
        return out;
      }
      if (load === 1) {
        out.timing.info_ms = Math.round(now() - t0);
        out.title = info.title;
        out.length_s = info.lengthSeconds;
        out.playability = { status: info.status, reason: info.reason, subreason: info.subreason };
        const cls = classify(info);
        if (cls) {
          out.error = { code: cls, detail: [info.status, info.reason, info.subreason].filter(Boolean).join(' · ') };
          return out;
        }
        out.tracks = toTracks(info.tracks);
        if (!out.tracks.length) {
          out.error = { code: 'no_transcript', detail: 'no caption tracks' };
          return out;
        }
        const asr = flags.asr === true ? true : flags.manual === true ? false : undefined;
        pick = pickTrack(out.tracks, opts.lang, asr);
        if (!pick) {
          out.error = { code: 'no_transcript', detail: `no track for ${opts.lang}${asr === undefined ? '' : asr ? ' (asr)' : ' (manual)'}` };
          return out;
        }
        out.chosen = pick;
        if (method === 'panel') break;
      }
      const rep = { t0, base, videoId };
      // the auto method keeps ~6 s at the end for the panel
      const stopAt = method === 'player' ? deadline : deadline - 6000;
      const r = await viaPlayer(wc, rec, videoId, pick, stopAt, rep);
      (out.player ??= []).push({ load, why: r.ok ? 'ok' : r.why, ...rep, t0: undefined, base: undefined, videoId: undefined });
      if (r.ok) {
        Object.assign(out, { ok: true, method: `timedtext/${r.fmt}`, snippets: r.snippets });
        out.timing.body_ms = r.at;
        return out;
      }
      if (r.why !== 'token-refused' || left() < 14000) break;
      log(videoId, 'token refused → reload');
    }

    // 2순위: the transcript panel's own response (one language, whole seconds)
    if (method === 'player') {
      out.error = { code: 'timeout', detail: 'the player gave no caption body' };
      return out;
    }
    const tp = now();
    await rec.attachCdp();
    const from = rec.recs.length;
    let opened = null;
    while (!opened && left() > 0) {
      opened = await evalIn(wc, OPEN_PANEL).catch(() => null);
      if (!opened) await sleep(300);
    }
    out.panel = { opened_by: opened };
    const r = opened ? await rec.waitFor((x) => x.src === 'cdp' && x.kind === 'panel' && x.i >= from && parsePanel(x.body, info.lengthSeconds).length > 0, left()) : null;
    out.panel.ms = Math.round(now() - tp);
    if (r) {
      Object.assign(out, { ok: true, method: new URL(r.url).pathname.split('/').pop(), snippets: parsePanel(r.body, info.lengthSeconds) });
      out.timing.body_ms = r.at;
      return out;
    }
    out.error = { code: 'timeout', detail: 'neither the player nor the panel gave a caption body' };
    return out;
  } finally {
    out.timing.total_ms = Math.round(now() - t0);
    rec?.close();
    win.destroy();
  }
}

async function compareWithServer(r) {
  if (!r.ok || !r.chosen) return null;
  const base = 'https://lab.mindvest.ai/api/scriptlens/transcript';
  const res = await fetch(`${base}/${r.video_id}?lang=${encodeURIComponent(r.chosen.language_code)}`, { signal: AbortSignal.timeout(40000) }).catch((e) => ({ ok: false, status: String(e) }));
  if (!res.ok) return { server: `HTTP ${res.status}` };
  const s = await res.json();
  const cmp = { server_is_generated: s.is_generated, server_count: s.snippets.length, app_count: r.snippets.length };
  if (s.is_generated !== r.chosen.is_generated) return { ...cmp, note: 'the server picked the other kind of track' };
  let same = 0;
  let textSame = 0;
  let firstDiff = null;
  const n = Math.max(s.snippets.length, r.snippets.length);
  for (let i = 0; i < n; i++) {
    const a = s.snippets[i];
    const b = r.snippets[i];
    if (a && b && a.text === b.text) textSame++;
    if (a && b && a.text === b.text && Math.abs(a.start - b.start) < 0.0015 && Math.abs(a.duration - b.duration) < 0.0015) same++;
    else if (!firstDiff) firstDiff = { i, server: a ?? null, app: b ?? null };
  }
  return { ...cmp, identical: same, same_text: textSame, first_diff: firstDiff };
}

async function search(q) {
  const win = hiddenWindow(!!flags.show);
  try {
    const sp = flags.cc ? '&sp=EgIoAQ%253D%253D' : '';
    win.webContents.loadURL(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en${sp}`).catch(() => {});
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const rows = await evalIn(
        win.webContents,
        `(() => {
          const out = [];
          (function walk(o) {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) return o.forEach(walk);
            if (o.videoRenderer && o.videoRenderer.videoId) {
              const v = o.videoRenderer;
              const t = (x) => x ? (x.simpleText || (x.runs || []).map((r) => r.text).join('')) : '';
              out.push({ id: v.videoId, title: t(v.title), len: t(v.lengthText), ch: t(v.ownerText),
                badges: (v.badges || []).map((b) => b.metadataBadgeRenderer && b.metadataBadgeRenderer.label).filter(Boolean) });
              return;
            }
            for (const k in o) walk(o[k]);
          })(window.ytInitialData);
          return out;
        })()`,
      ).catch(() => []);
      if (rows.length) return rows;
    }
    return [];
  } finally {
    win.destroy();
  }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const watchdog = setTimeout(() => {
    process.stderr.write('[probe] watchdog: giving up\n');
    app.exit(3);
  }, Math.max(1, ids.length) * (TIMEOUT + 60000));
  const ses = youtubeSession();
  if (flags.offline) await ses.setProxy({ proxyRules: 'http://127.0.0.1:9' }); // nothing listens there: the network error's shape
  try {
    if (flags.search) {
      process.stdout.write(`${JSON.stringify(await search(String(flags.search)))}\n`);
      return;
    }
    if (!ids.length) throw new Error('usage: electron probe/probe.mjs <videoId...> [--lang=xx] [--asr|--manual] [--method=auto|player|panel]');
    for (const id of ids) {
      const r = await probe(id, { lang: flags.lang, method: flags.method, show: !!flags.show });
      if (flags.compare) r.compare = await compareWithServer(r).catch((e) => ({ error: String(e) }));
      if (!flags.full && r.snippets) {
        r.snippet_count = r.snippets.length;
        r.snippets_head = r.snippets.slice(0, 2);
        delete r.snippets;
      }
      if (!flags.full && r.tracks && r.tracks.length > 6) {
        r.track_count = r.tracks.length;
        r.tracks = r.tracks.filter((t) => ['ko', 'en'].includes(t.language_code) || t.is_generated);
      }
      process.stdout.write(`${JSON.stringify(r)}\n`);
      if (flags.gap) await sleep(Number(flags.gap));
    }
  } catch (e) {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    app.quit();
  }
});
