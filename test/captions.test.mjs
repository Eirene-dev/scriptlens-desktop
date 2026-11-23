// The fetcher's pure parts, against what YouTube sends (fixtures from Stage 0 — texts rewritten, tokens redacted).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseJson3, parsePanel, parseTimedtext, parseTimedtextXml, parseClock } from '../src/captions/parse.mjs';
import { isWantedTimedtext, kindOf, potOf } from '../src/captions/match.mjs';
import { classifyPlayability, fail, toTracks, NET_ERR } from '../src/captions/classify.mjs';
import { Deadline } from '../src/captions/deadline.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const URLS = JSON.parse(fixture('timedtext-urls.json'));

describe('json3 (/api/timedtext?fmt=json3)', () => {
  it('a manual track: one snippet per event, line breaks kept, ms → s', () => {
    const body = JSON.stringify({
      wireMagic: 'pb3',
      events: [
        { tStartMs: 27103, dDurationMs: 2575, segs: [{ utf8: '첫 문장입니다.' }] },
        { tStartMs: 43096, dDurationMs: 3567, segs: [{ utf8: '두 줄로\n나뉜 문장' }] },
      ],
    });
    expect(parseJson3(body)).toEqual([
      { text: '첫 문장입니다.', start: 27.103, duration: 2.575 },
      { text: '두 줄로\n나뉜 문장', start: 43.096, duration: 3.567 },
    ]);
  });

  it('an auto-generated track: word segments joined, window and append ("\\n") events dropped', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1197000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
        { tStartMs: 2000, dDurationMs: 5040, wWinId: 1, segs: [{ utf8: '지금', acAsrConf: 0 }, { utf8: ' 시작', tOffsetMs: 480, acAsrConf: 0 }] },
        { tStartMs: 4560, dDurationMs: 2480, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 4570, dDurationMs: 4990, wWinId: 1, segs: [{ utf8: '합니다' }] },
      ],
    });
    expect(parseJson3(body)).toEqual([
      { text: '지금 시작', start: 2, duration: 5.04 },
      { text: '합니다', start: 4.57, duration: 4.99 },
    ]);
  });

  it('an empty 200 (a refused PoToken) parses to nothing, not an error', () => {
    expect(parseTimedtext('')).toEqual([]);
  });
});

describe('timedtext XML', () => {
  it('format 1 and srv3, entities decoded', () => {
    expect(parseTimedtextXml('<transcript><text start="1.5" dur="2">A &amp; B &#39;c&#39;</text></transcript>')).toEqual([
      { text: "A & B 'c'", start: 1.5, duration: 2 },
    ]);
    expect(parseTimedtextXml('<timedtext><body><p t="1500" d="2000">one<br/>two</p></body></timedtext>')).toEqual([
      { text: 'one\ntwo', start: 1.5, duration: 2 },
    ]);
  });
});

describe('the transcript panel (/youtubei/v1/get_panel, the 2026 view)', () => {
  const body = fixture('get-panel-modern.json');
  const rows = parsePanel(body, 1203);

  it('finds the segments wherever they sit, chapters left out', () => {
    expect(rows.length).toBe((body.match(/transcriptSegmentViewModel/g) ?? []).length);
    expect(rows[0]).toEqual({ text: '문장 1입니다.', start: 27, duration: rows[1].start - 27 });
    expect(rows.every((r) => Number.isInteger(r.start))).toBe(true);
  });

  it('the last segment runs to the end of the video', () => {
    const last = rows.at(-1);
    expect(last.start + last.duration).toBe(1203);
  });

  it('clock strings', () => {
    expect(parseClock('7:02')).toBe(422);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('x')).toBeNull();
  });
});

describe('which response is the asked one', () => {
  const asrKo = { language_code: 'ko', is_generated: true };
  const manualEn = { language_code: 'en', is_generated: false };

  it('the content video, its track', () => {
    expect(isWantedTimedtext(URLS.content_asr_ko, 'k6i_4oGdx_E', asrKo)).toBe(true);
    expect(isWantedTimedtext(URLS.content_manual_en, 'iG9CE55wbtY', manualEn)).toBe(true);
  });

  it('never an ad in front, even with the same language and kind (Stage 0 once took a Korean ad’s 6 lines)', () => {
    expect(new URL(URLS.ad_asr_ko).searchParams.get('v')).toBe('XFY0GkrMSig');
    expect(isWantedTimedtext(URLS.ad_asr_ko, 'k6i_4oGdx_E', asrKo)).toBe(false);
  });

  it('never a translation the player asked on its own (tlang=)', () => {
    expect(isWantedTimedtext(URLS.content_asr_ko_translated_ja, 'k6i_4oGdx_E', asrKo)).toBe(false);
  });

  it('manual and auto-generated are told apart', () => {
    expect(isWantedTimedtext(URLS.content_asr_ko, 'k6i_4oGdx_E', { language_code: 'ko', is_generated: false })).toBe(false);
    expect(isWantedTimedtext(URLS.content_manual_en, 'iG9CE55wbtY', { language_code: 'en', is_generated: true })).toBe(false);
  });

  it('the PoToken is read from the URL; the first request has none', () => {
    expect(potOf(URLS.content_manual_en)).toBe('REDACTED');
    expect(potOf(URLS.content_manual_en_no_pot)).toBeNull();
  });

  it('kinds', () => {
    expect(kindOf(URLS.content_manual_en)).toBe('timedtext');
    expect(kindOf('https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false')).toBe('panel');
    expect(kindOf('https://www.youtube.com/youtubei/v1/player')).toBeNull();
  });
});

describe('playability → the contract’s codes', () => {
  const c = (status, reason, subreason) => classifyPlayability({ status, reason, subreason });
  it('plays', () => expect(c('OK')).toBeNull());
  it('gone (Stage 0: aaaaaaaaaaa)', () => expect(c('ERROR', 'This video is unavailable')).toMatchObject({ code: 'unavailable' }));
  it('age', () => expect(c('LOGIN_REQUIRED', 'Sign in to confirm your age')).toMatchObject({ code: 'login_required', message: expect.stringContaining('연령') }));
  it('bot check', () =>
    expect(c('LOGIN_REQUIRED', "Sign in to confirm you're not a bot")).toMatchObject({ code: 'login_required', message: expect.stringContaining('로봇') }));
  it('private', () => expect(c('LOGIN_REQUIRED', 'This video is private')).toMatchObject({ code: 'unavailable', message: '비공개 영상입니다.' }));
  it('region', () =>
    expect(c('UNPLAYABLE', 'Video unavailable', 'The uploader has not made this video available in your country')).toMatchObject({ code: 'unavailable' }));
  it('members', () => expect(c('UNPLAYABLE', 'Join this channel to get access to members-only content')).toMatchObject({ code: 'login_required' }));
  it('fail() keeps the contract codes', () => {
    expect(fail('no_track')).toMatchObject({ ok: false, code: 'no_transcript' });
    expect(fail('busy').code).toBe('busy');
  });
  it('network errors', () => {
    expect(NET_ERR.test('net::ERR_INTERNET_DISCONNECTED')).toBe(true);
    expect(NET_ERR.test('net::ERR_PROXY_CONNECTION_FAILED')).toBe(true);
    expect(NET_ERR.test('net::ERR_BLOCKED_BY_CLIENT')).toBe(false);
  });
  it('tracks in the lab’s shape', () => {
    expect(toTracks([{ name: 'Korean (auto-generated)', languageCode: 'ko', kind: 'asr', isTranslatable: true }])).toEqual([
      { language: 'Korean (auto-generated)', language_code: 'ko', is_generated: true, is_translatable: true },
    ]);
  });
});

describe('the time limit stops while an ad plays', () => {
  it('ads lengthen it, up to the cap', () => {
    let t = 0;
    const dl = new Deadline(40_000, 90_000, () => t);
    t = 1_000;
    dl.noteAd(true);
    t = 31_000; // a 30-second ad
    expect(dl.left()).toBe(39_000); // 1 s of ours used; the ad's 30 s not counted
    dl.noteAd(false);
    t = 60_000;
    expect(dl.left()).toBe(10_000);
    dl.noteAd(true);
    t = 89_000;
    expect(dl.left()).toBe(1_000); // the cap
    t = 91_000;
    expect(dl.left()).toBeLessThan(0);
    expect(dl.adMs()).toBe(30_000 + 31_000);
  });
});
