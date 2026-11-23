/**
 * Captions through a hidden YouTube page — the method Stage 0 checked (STAGE0.md).
 *
 * The page is the real https://www.youtube.com/watch?v=ID in a hidden, muted window of its own session. YouTube's own
 * JavaScript builds the player, mints its PoToken and fetches the captions; we ask the player to turn a track on and read
 * the /api/timedtext response it receives (session.webRequest for its status and length, the DevTools protocol for its
 * body). No request to YouTube is made by this code. If that fails, the transcript panel's own response is the fallback.
 *
 * One video at a time: a request for another video stops the one in progress. The page stays a minute after a request so
 * the next one for the same video (another track) does not load it again.
 */
import { BrowserWindow, session } from 'electron';
import { parsePanel, parseTimedtext } from './parse.mjs';
import { OPEN_PANEL, PAUSE, PLAY, PLAYER_STATE, READ_INFO, RETOGGLE, SKIP_TARGET, turnOnTrack } from './page-scripts.mjs';
import { isWantedTimedtext, kindOf, potOf } from './match.mjs';
import { NET_ERR, classifyPlayability, fail, ok, toTracks } from './classify.mjs';
import { Deadline } from './deadline.mjs';
import { VIDEO_ID_RE } from '../policy.mjs';

export const LIMITS = {
  /** our own working time per request; the clock stops while an ad plays */
  activeMs: 40_000,
  /** the cap however long the ads run */
  hardMs: 90_000,
  /** kept at the end of a request for the transcript-panel fallback */
  panelReserveMs: 6_000,
  /** how long a page stays open after a request */
  keepAliveMs: 60_000,
  /** page loads per request — a second one when the PoToken was refused */
  maxLoads: 2,
  /** an ad whose position has not moved this long is stalled: go to the panel */
  adStallMs: 15_000,
  /** ads past this long (in all, this request) send us to the transcript panel instead of waiting them out */
  adPanelMs: 10_000,
  /** how long the panel may take while the ad plays on — after that, back to waiting the ad out (up to hardMs) */
  adPanelTryMs: 10_000,
  /** press YouTube's Skip button when it offers one — off for now (the panel covers long ads); the code stays */
  pressSkip: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => performance.now();
class Aborted extends Error {}

/** executeJavaScript never settles if the page navigates under it — bound every call */
function evalIn(wc, code, ms = 3000) {
  let timer;
  return Promise.race([
    wc.executeJavaScript(code),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('eval-timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const trackKey = (t) => `${t.language_code}:${t.is_generated ? 'asr' : 'manual'}`;

/** One hidden YouTube page, with the record of its caption responses. */
class YouTubePage {
  constructor(partition, videoId, log) {
    this.partition = partition;
    this.videoId = videoId;
    this.log = log;
    this.recs = [];
    this.waiters = new Set();
    this.netErrors = [];
    this.cache = new Map();
    this.info = null;
    this.tracks = [];
    this.loadBase = 0;
    this.cdp = null;
    this.dead = false;
    this.win = null;
    this.wc = null;
  }

  push(rec) {
    rec.i = this.recs.length;
    this.recs.push(rec);
    for (const w of this.waiters) w(rec);
  }

  /** the first record (already in, or arriving) that `pred` accepts, or null after `ms` */
  waitFor(pred, ms) {
    return new Promise((resolve) => {
      const hit = this.recs.find(pred);
      if (hit) return resolve(hit);
      const w = (rec) => {
        if (!pred(rec)) return;
        this.waiters.delete(w);
        clearTimeout(timer);
        resolve(rec);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve(null);
      }, Math.max(0, ms));
      this.waiters.add(w);
    });
  }

  /** from session.webRequest — status and Content-Length (-1 when the header is absent) */
  onTimedtext(d) {
    if (!this.wc || d.webContentsId !== this.wc.id) return;
    const len = Object.entries(d.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === 'content-length')?.[1]?.[0];
    this.push({ src: 'wr', kind: 'timedtext', url: d.url, status: d.statusCode, len: len == null ? -1 : Number(len) });
  }

  onError(d) {
    if (this.wc && d.webContentsId === this.wc.id && NET_ERR.test(d.error)) this.netErrors.push(d.error);
  }

  async open(dl, signal) {
    this.win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1280,
      height: 800,
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    this.wc = this.win.webContents;
    this.wc.setAudioMuted(true);
    this.wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // the page stays on YouTube
    this.wc.on('will-navigate', (e, url) => {
      if (!/^https:\/\/(www\.|m\.)?youtube\.com\//.test(url)) e.preventDefault();
    });
    this.wc.on('render-process-gone', () => {
      this.dead = true;
    });
    // the DevTools protocol needs a renderer: a blank page first
    await this.wc.loadURL('about:blank');
    return this.load(dl, signal);
  }

  /** (re)load the watch page and read its player response → {} or { error } */
  async load(dl, signal) {
    this.info = null;
    this.loadBase = this.recs.length;
    this.netErrors = [];
    let loadError = null;
    const t0 = now();
    this.wc.loadURL(`https://www.youtube.com/watch?v=${this.videoId}&hl=en`).catch((e) => {
      if (e && e.code !== 'ERR_ABORTED') loadError = e;
    });
    while (dl.left() > 0) {
      if (signal.aborted) throw new Aborted();
      if (loadError) return { error: fail(NET_ERR.test(String(loadError.code)) ? 'network' : 'timeout') };
      // YouTube's service worker can serve a page shell offline: no load error, but no player either
      if (this.netErrors.length >= 3 && now() - t0 > 4000) return { error: fail('network') };
      await sleep(150);
      const info = await evalIn(this.wc, READ_INFO).catch(() => null);
      if (info && (!info.videoId || info.videoId === this.videoId)) {
        this.info = info;
        this.tracks = toTracks(info.tracks);
        return {};
      }
    }
    return { error: fail(this.netErrors.length ? 'network' : 'timeout') };
  }

  async attachCdp() {
    if (this.cdp) return this.cdp;
    const dbg = this.wc.debugger;
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
            this.push({ src: 'cdp', ...p, body: base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body }),
          )
          .catch(() => {});
      } else if (method === 'Network.loadingFailed') {
        pending.delete(params.requestId);
      }
    });
    this.cdp = Promise.race([
      dbg.sendCommand('Network.enable', { maxResourceBufferSize: 64e6, maxTotalBufferSize: 256e6 }),
      sleep(5000).then(() => Promise.reject(new Error('Network.enable timeout'))),
    ]);
    return this.cdp;
  }

  eval(code, ms) {
    return evalIn(this.wc, code, ms);
  }

  /** a left-button press and release at (x, y), through the DevTools protocol — trusted input, no window focus needed */
  async press({ x, y }) {
    await this.attachCdp();
    const dbg = this.wc.debugger;
    const base = { x, y, button: 'left', clickCount: 1 };
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  close() {
    this.dead = true;
    for (const w of this.waiters) this.waiters.delete(w);
    try {
      if (this.cdp) this.wc.debugger.detach();
    } catch {}
    try {
      this.win?.destroy();
    } catch {}
  }
}

export class CaptionFetcher {
  #partition;
  #log;
  #limits;
  #forcePanel;
  #page = null;
  #closeTimer = null;
  #chain = Promise.resolve();
  #jobs = new Set();

  constructor({ partition, log = () => {}, limits = {}, forcePanel = false }) {
    this.#partition = partition;
    this.#log = log;
    this.#limits = { ...LIMITS, ...limits };
    this.#forcePanel = forcePanel;
    const ses = session.fromPartition(partition);
    // Electron's own user agent, untouched: with "Electron/x" stripped (a Chrome-looking UA) about half the PoTokens were
    // refused (STAGE0.md). English for the page: track names as the lab knew them, and error reasons we can read.
    ses.setUserAgent(ses.getUserAgent(), 'en-US,en');
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // one listener per event per session: hand each to the page it belongs to
    ses.webRequest.onCompleted({ urls: ['https://www.youtube.com/api/timedtext*'] }, (d) => this.#page?.onTimedtext(d));
    ses.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (d) => this.#page?.onError(d));
  }

  /** → { ok, data: { video_id, title, tracks } } | { ok: false, code, message } */
  listTracks(videoId) {
    return this.#run(videoId, 'listTracks', (job) => this.#listTracks(videoId, job));
  }

  /** → { ok, data: TranscriptData & { source } } | { ok: false, code, message } */
  getTranscript(videoId, track) {
    return this.#run(videoId, 'getTranscript', (job) => this.#getTranscript(videoId, track, job));
  }

  dispose() {
    for (const j of this.#jobs) j.controller.abort();
    this.#closePage();
  }

  #run(videoId, what, fn) {
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return Promise.resolve(fail('bad_request'));
    // a request for another video stops the one in progress and those waiting
    for (const j of this.#jobs) if (j.videoId !== videoId) j.controller.abort();
    const job = { videoId, controller: new AbortController() };
    this.#jobs.add(job);
    const t0 = now();
    const result = this.#chain.then(async () => {
      if (job.controller.signal.aborted) return fail('busy');
      try {
        return await fn(job);
      } catch (e) {
        if (e instanceof Aborted) return fail('busy');
        this.#log('fetch-error', { what, videoId, error: String(e?.message ?? e) });
        this.#closePage();
        return fail('timeout');
      } finally {
        this.#jobs.delete(job);
      }
    });
    this.#chain = result.then(
      (r) => this.#log('fetch', { what, videoId, ms: Math.round(now() - t0), ok: r.ok, code: r.ok ? undefined : r.code }),
      () => {},
    );
    return result;
  }

  #newDeadline() {
    return new Deadline(this.#limits.activeMs, this.#limits.hardMs);
  }

  #closePage() {
    clearTimeout(this.#closeTimer);
    this.#page?.close();
    this.#page = null;
  }

  #keepPage() {
    clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(() => this.#closePage(), this.#limits.keepAliveMs);
  }

  async #ensurePage(videoId, dl, job) {
    clearTimeout(this.#closeTimer);
    const cur = this.#page;
    if (cur && cur.videoId === videoId && cur.info && !cur.dead) return { page: cur };
    this.#closePage();
    const page = new YouTubePage(this.#partition, videoId, this.#log);
    this.#page = page;
    const r = await page.open(dl, job.controller.signal);
    if (r.error) {
      this.#closePage();
      return { error: r.error };
    }
    return { page };
  }

  async #listTracks(videoId, job) {
    const dl = this.#newDeadline();
    const got = await this.#ensurePage(videoId, dl, job);
    if (got.error) return got.error;
    const page = got.page;
    const bad = classifyPlayability(page.info);
    if (bad) {
      this.#closePage();
      return bad;
    }
    this.#keepPage();
    if (!page.tracks.length) return fail('no_transcript');
    return ok({ video_id: videoId, title: page.info.title, tracks: page.tracks });
  }

  async #getTranscript(videoId, track, job) {
    const dl = this.#newDeadline();
    const got = await this.#ensurePage(videoId, dl, job);
    if (got.error) return got.error;
    const page = got.page;
    const bad = classifyPlayability(page.info);
    if (bad) {
      this.#closePage();
      return bad;
    }
    const t = page.tracks.find((x) => x.language_code === track.language_code && x.is_generated === track.is_generated);
    if (!t) {
      this.#keepPage();
      return fail(page.tracks.length ? 'no_track' : 'no_transcript');
    }
    const key = trackKey(t);
    if (page.cache.has(key)) {
      this.#keepPage();
      return ok(page.cache.get(key));
    }

    const panelResult = async (snippets) => {
      await page.eval(PAUSE).catch(() => null);
      this.#keepPage();
      return ok({
        video_id: videoId,
        language: 'YouTube 스크립트 패널',
        language_code: 'panel',
        is_generated: false,
        title: page.info.title,
        source: 'panel',
        snippets,
      });
    };

    if (!this.#forcePanel) {
      let adPanel = true; // one go at the panel while a long ad plays
      for (let load = 1; ; load++) {
        const r = await this.#viaPlayer(page, t, dl, job, { adPanel });
        this.#log('player', { videoId, track: key, load, why: r.ok ? 'ok' : r.why, ad: r.ad || undefined, adMs: Math.round(dl.adMs()) || undefined });
        if (r.why === 'ad-long') {
          // the panel is the page's, not the player's: it does not wait for the ad
          adPanel = false;
          const t0 = now();
          const snippets = await this.#viaPanel(page, dl, job, this.#limits.adPanelTryMs);
          const st = await page.eval(PLAYER_STATE).catch(() => null);
          this.#log('panel', { videoId, track: key, ok: !!snippets, duringAd: true, adStill: !!st?.ad, ms: Math.round(now() - t0) });
          if (snippets) return panelResult(snippets);
          load--; // the same load: wait the ad out after all
          continue;
        }
        if (r.ok) {
          const data = {
            video_id: videoId,
            language: t.language,
            language_code: t.language_code,
            is_generated: t.is_generated,
            title: page.info.title,
            source: 'timedtext',
            snippets: r.snippets,
          };
          page.cache.set(key, data);
          await page.eval(PAUSE).catch(() => null);
          this.#keepPage();
          return ok(data);
        }
        if (r.why !== 'token-refused' || load >= this.#limits.maxLoads || dl.left() < 14_000) break;
        const re = await page.load(dl, job.controller.signal);
        if (re.error) {
          this.#closePage();
          return re.error;
        }
      }
    }

    const snippets = await this.#viaPanel(page, dl, job);
    this.#log('panel', { videoId, track: key, ok: !!snippets });
    if (snippets) return panelResult(snippets);
    const net = page.netErrors.length > 0;
    this.#closePage(); // something is off: the next try starts clean
    return fail(net ? 'network' : 'timeout');
  }

  /** 1순위 → { ok: true, snippets } | { ok: false, why } — why 'ad-long': ads past adPanelMs, try the panel (opts.adPanel) */
  async #viaPlayer(page, track, dl, job, { adPanel = false } = {}) {
    const signal = job.controller.signal;
    const leftForUs = () => dl.left() - this.#limits.panelReserveMs;
    const want = (x) => x.kind === 'timedtext' && x.i >= page.loadBase && isWantedTimedtext(x.url, page.videoId, track);
    let ad = false;

    // a. turn the track on once the content player offers it — an ad in front is waited out, its time not counted;
    //    ads past adPanelMs, or one that stops moving, send us to the panel (and Skip is pressed only if pressSkip)
    let on = null;
    const t1 = now();
    const adLog = { first: null, samples: 0, skipPressed: 0, lastPress: 0, lastT: null, lastMove: 0, kicked: false };
    while (leftForUs() > 0) {
      if (signal.aborted) throw new Aborted();
      const st = await page.eval(PLAYER_STATE).catch(() => null);
      dl.noteAd(!!st?.ad);
      if (st?.ad) {
        ad = true;
        adLog.samples++;
        adLog.first ??= { t: st.t, dur: st.dur };
        if (st.t !== adLog.lastT) {
          adLog.lastT = st.t;
          adLog.lastMove = now();
        }
        if (st.skip && this.#limits.pressSkip && adLog.skipPressed < 3 && now() - (adLog.lastPress ?? 0) > 1500) {
          const at = await page.eval(SKIP_TARGET).catch(() => null);
          if (at) {
            adLog.lastPress = now();
            adLog.skipPressed++;
            await page.press(at).catch((e) => this.#log('skip-error', { error: String(e?.message ?? e) }));
          }
        }
        const still = now() - adLog.lastMove;
        if (still > 5_000 && !adLog.kicked) {
          adLog.kicked = true;
          await page.eval(PLAY).catch(() => null);
        }
        if (still > this.#limits.adStallMs) {
          dl.noteAd(false);
          this.#log('ad', { videoId: page.videoId, ...adLog, stalled: true, adMs: Math.round(dl.adMs()) });
          return { ok: false, why: 'ad-stalled', ad };
        }
        if (adPanel && dl.adMs() > this.#limits.adPanelMs) {
          dl.noteAd(false);
          this.#log('ad', { videoId: page.videoId, first: adLog.first, skip: !!st.skip, adMs: Math.round(dl.adMs()), toPanel: true });
          return { ok: false, why: 'ad-long', ad };
        }
      } else {
        if (ad && adLog.samples) {
          this.#log('ad', { videoId: page.videoId, first: adLog.first, skipPressed: adLog.skipPressed, adMs: Math.round(dl.adMs()), endedAtT: adLog.lastT });
          adLog.samples = 0;
        }
        on = await page.eval(turnOnTrack(page.videoId, track.language_code, track.is_generated)).catch(() => null);
        if (on?.ok) break;
        if (on?.why === 'track-not-in-player' && now() - t1 > 10_000) return { ok: false, why: 'not-offered', ad };
      }
      await sleep(300);
    }
    dl.noteAd(false);
    if (ad && adLog.samples) this.#log('ad', { videoId: page.videoId, first: adLog.first, skipPressed: adLog.skipPressed, adMs: Math.round(dl.adMs()), cut: true });
    if (!on?.ok) return { ok: false, why: ad ? 'ad' : 'not-offered', ad };

    // b. the first request goes out without a token and comes back empty; off and on again sends it with the token
    let from = page.loadBase;
    let toggles = 0;
    for (;;) {
      if (signal.aborted) throw new Aborted();
      const since = from;
      const r = await page.waitFor((x) => x.src === 'wr' && x.i >= since && want(x), Math.min(5000, leftForUs()));
      if (!r) return { ok: false, why: 'no-request', ad };
      from = r.i + 1;
      if (!potOf(r.url)) {
        if (toggles >= 4 || leftForUs() < 1500) return { ok: false, why: 'no-request', ad };
        await sleep(700);
        await page.eval(RETOGGLE).catch(() => null);
        toggles++;
        continue;
      }
      if (r.len === 0) return { ok: false, why: 'token-refused', ad };

      // c. a token that works: read the body — this response's if the protocol was already on, else ask once more
      if (page.cdp) {
        const b = await page.waitFor((x) => x.src === 'cdp' && x.url === r.url, 3000);
        const snippets = b ? parseTimedtext(b.body) : [];
        if (snippets.length) return { ok: true, snippets, ad };
      }
      await page.attachCdp();
      const mark = page.recs.length;
      await page.eval(RETOGGLE).catch(() => null);
      const b = await page.waitFor((x) => x.src === 'cdp' && x.i >= mark && want(x), Math.min(5000, leftForUs()));
      if (!b) return { ok: false, why: 'no-body', ad };
      let snippets = [];
      try {
        snippets = parseTimedtext(b.body);
      } catch {}
      if (snippets.length) return { ok: true, snippets, ad };
      return { ok: false, why: potOf(b.url) ? 'token-refused' : 'no-body', ad };
    }
  }

  /**
   * 2순위: the transcript panel's own response — one language, whole seconds; null if it gave nothing in `ms`.
   * Any panel response of this load counts: one that came late to an earlier try is not asked for again.
   */
  async #viaPanel(page, dl, job, ms = Infinity) {
    const signal = job.controller.signal;
    const until = now() + Math.min(ms, Math.max(0, dl.left()));
    const left = () => until - now();
    await page.attachCdp();
    const from = page.loadBase;
    let opened = null;
    while (!opened && left() > 0) {
      if (signal.aborted) throw new Aborted();
      opened = await page.eval(OPEN_PANEL).catch(() => null);
      if (!opened) await sleep(300);
    }
    if (!opened) return null;
    const len = page.info.lengthSeconds;
    const r = await page.waitFor((x) => {
      if (x.src !== 'cdp' || x.kind !== 'panel' || x.i < from) return false;
      try {
        return parsePanel(x.body, len).length > 0;
      } catch {
        return false;
      }
    }, left());
    return r ? parsePanel(r.body, len) : null;
  }
}
