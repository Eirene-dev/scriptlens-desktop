// Small scripts run in the hidden YouTube page (main world). They read the page and ask YouTube's own player to
// act; none of them makes a request itself.

/** the page's player response: playability, title, length, caption tracks — null until the player is there */
export const READ_INFO = `(() => {
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
  return {
    status: ps.status || null, reason: ps.reason || null, subreason: em ? txt(em.subreason) : null,
    title: vd.title || null, videoId: vd.videoId || null, lengthSeconds: Number(vd.lengthSeconds || 0), tracks,
  };
})()`;

const SKIP_SELECTOR = '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button[id^="skip-button"]';

/** ad: an ad shows; t/dur: where the playing video (the ad, during one) is; skip: YouTube offers its Skip button */
export const PLAYER_STATE = `(() => {
  const p = document.getElementById('movie_player');
  if (!p) return null;
  const v = p.querySelector('video');
  const skip = [...document.querySelectorAll('${SKIP_SELECTOR}')].some((b) => b.offsetParent !== null && !b.disabled);
  return {
    ad: p.classList.contains('ad-showing'),
    state: typeof p.getPlayerState === 'function' ? p.getPlayerState() : null,
    t: v ? Math.round(v.currentTime * 10) / 10 : null,
    dur: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    skip,
  };
})()`;

/**
 * Where YouTube's Skip button is, to press it — only when the point's topmost element is that button, so a press can
 * never land on the ad itself. (A script's click() on it is ignored by YouTube; the press goes through the DevTools
 * protocol's mouse input, as a person's would.) Nobody sees the hidden page to press it; a long skippable ad would
 * otherwise hold a request for up to the cap.
 */
export const SKIP_TARGET = `(() => {
  const b = [...document.querySelectorAll('${SKIP_SELECTOR}')].find((x) => x.offsetParent !== null && !x.disabled);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  const hit = document.elementFromPoint(x, y);
  return hit && (hit === b || b.contains(hit)) ? { x, y } : null;
})()`;

/** an ad that stopped moving: ask the player to go on */
export const PLAY = `(() => { const p = document.getElementById('movie_player'); try { p.playVideo(); } catch (e) {} return true; })()`;

/**
 * Turn the track on. Never while an ad shows, and only when the player holds the asked video — an ad has captions
 * of its own. Auto-generated tracks are listed only with includeAsr.
 */
export function turnOnTrack(videoId, languageCode, isGenerated) {
  return `(() => {
    const p = document.getElementById('movie_player');
    if (!p || typeof p.getOption !== 'function') return { ok: false, why: 'no-player-api' };
    try { p.mute(); } catch (e) {}
    if (p.classList.contains('ad-showing')) return { ok: false, why: 'ad' };
    const vd = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
    if (!vd || vd.video_id !== ${JSON.stringify(videoId)}) return { ok: false, why: 'other-video' };
    try { p.loadModule('captions'); } catch (e) {}
    let list = [];
    try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (e) {}
    const t = list.find((x) => x.languageCode === ${JSON.stringify(languageCode)} && ((x.kind === 'asr') === ${isGenerated ? 'true' : 'false'}));
    if (!t) return { ok: false, why: 'track-not-in-player', n: list.length };
    p.setOption('captions', 'track', t);
    return { ok: true };
  })()`;
}

/** off and on again: the player asks /api/timedtext once more, with the PoToken it has by then */
export const RETOGGLE = `(() => {
  const p = document.getElementById('movie_player');
  if (!p || p.classList.contains('ad-showing')) return false;
  const t = p.getOption('captions', 'track');
  p.setOption('captions', 'track', {});
  p.unloadModule('captions');
  p.loadModule('captions');
  p.setOption('captions', 'track', t);
  return !!(t && t.languageCode);
})()`;

/** stop playback once a transcript is in (never during an ad) — the page may stay open a minute for another track */
export const PAUSE = `(() => {
  const p = document.getElementById('movie_player');
  if (p && !p.classList.contains('ad-showing') && typeof p.pauseVideo === 'function') { try { p.pauseVideo(); } catch (e) {} }
  return true;
})()`;

/** the fallback: open the transcript panel — its own request (/youtubei/v1/get_panel) brings the text */
export const OPEN_PANEL = `(() => {
  const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
  if (btn) { btn.click(); return 'button'; }
  const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
  if (panel) { panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); return 'attribute'; }
  return null;
})()`;
