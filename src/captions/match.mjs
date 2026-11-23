// Which of the page's own responses is the one asked for. Pure — tested with URLs shaped as YouTube sends them.

export function kindOf(url) {
  if (url.includes('/api/timedtext')) return 'timedtext';
  if (url.includes('/youtubei/v1/get_panel') || url.includes('/youtubei/v1/get_transcript')) return 'panel';
  return null;
}

function params(url) {
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

export const potOf = (url) => params(url)?.get('pot') || null;

/**
 * A /api/timedtext response is the asked track's only if
 *  - v= is the asked video — an ad in front has captions of its own (Stage 0 once took a Korean ad's 6 lines);
 *  - lang= and kind= are the track's (kind=asr for an auto-generated one, none for a manual one);
 *  - it is not a translation (tlang=) — the player may ask one on its own, from the last caption setting it remembers.
 */
export function isWantedTimedtext(url, videoId, track) {
  const q = params(url);
  if (!q || kindOf(url) !== 'timedtext') return false;
  return (
    q.get('v') === videoId &&
    q.get('lang') === track.language_code &&
    (q.get('kind') === 'asr') === track.is_generated &&
    !q.get('tlang')
  );
}
