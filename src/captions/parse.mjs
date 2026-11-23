// Parsers for what YouTube's own page fetched. Nothing here makes a request.
// Output snippet shape = lab ScriptLens's Snippet: { text, start, duration } (seconds).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const sec = (ms) => Math.round(Number(ms)) / 1000;

/** /api/timedtext?fmt=json3 */
export function parseJson3(text) {
  const j = JSON.parse(text);
  const out = [];
  for (const ev of j.events ?? []) {
    if (!Array.isArray(ev.segs)) continue;
    const t = ev.segs.map((s) => s.utf8 ?? '').join('');
    if (!t.trim()) continue; // ASR "append" events carry only "\n"
    out.push({ text: t, start: sec(ev.tStartMs ?? 0), duration: sec(ev.dDurationMs ?? 0) });
  }
  return out;
}

/** /api/timedtext XML (format 1 <text start dur> or srv3 <p t d>) */
export function parseTimedtextXml(text) {
  const out = [];
  const f1 = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = f1.exec(text))) {
    const a = attrs(m[1]);
    const t = decodeEntities(m[2].replace(/<[^>]+>/g, ''));
    if (!t.trim()) continue;
    out.push({ text: t, start: Number(a.start ?? 0), duration: Number(a.dur ?? 0) });
  }
  if (out.length) return out;
  const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  while ((m = srv3.exec(text))) {
    const a = attrs(m[1]);
    const t = decodeEntities(m[2].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''));
    if (!t.trim()) continue;
    out.push({ text: t, start: sec(a.t ?? 0), duration: sec(a.d ?? 0) });
  }
  return out;
}

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

export function parseTimedtext(body) {
  const t = body.trimStart();
  if (t.startsWith('{')) return parseJson3(t);
  if (t.startsWith('<')) return parseTimedtextXml(t);
  return [];
}

/**
 * The transcript panel's response — /youtubei/v1/get_panel (the modern view, 2026: transcriptSegmentViewModel, whole
 * seconds, sentences merged) or /youtubei/v1/get_transcript (the older view: transcriptSegmentRenderer, milliseconds).
 * Segments are found wherever they sit.
 */
export function parsePanel(text, lengthSeconds = 0) {
  const j = JSON.parse(text);
  const legacy = [];
  const modern = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'transcriptSegmentRenderer' && v && typeof v === 'object') legacy.push(v);
      else if (k === 'transcriptSegmentViewModel' && v && typeof v === 'object') modern.push(v);
      else walk(v);
    }
  })(j);
  if (legacy.length) {
    return legacy
      .map((s) => {
        const text = s.snippet?.simpleText ?? (s.snippet?.runs ?? []).map((r) => r.text ?? '').join('');
        const start = sec(s.startMs ?? 0);
        const end = sec(s.endMs ?? s.startMs ?? 0);
        return { text, start, duration: Math.max(0, Math.round((end - start) * 1000) / 1000) };
      })
      .filter((s) => s.text.trim());
  }
  const rows = modern
    .map((s) => ({ text: s.simpleText ?? (s.text?.content ?? ''), start: parseClock(s.timestamp ?? '') }))
    .filter((s) => s.text.trim() && s.start != null);
  return rows.map((s, i) => {
    const next = rows[i + 1]?.start ?? (lengthSeconds > s.start ? lengthSeconds : s.start);
    return { text: s.text, start: s.start, duration: Math.max(0, next - s.start) };
  });
}

/** "1:02:03" / "2:03" → seconds */
export function parseClock(s) {
  const parts = String(s).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
