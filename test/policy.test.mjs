import { describe, expect, it } from 'vitest';
import { bridgeAllowed, compareVersions, navigationVerdict, readLatest, readTrack, resolveLabUrl, VIDEO_ID_RE } from '../src/policy.mjs';

const LAB = new URL('https://lab.mindvest.ai/scriptlens');

describe('the lab page to show', () => {
  it('the real one by default', () => {
    expect(resolveLabUrl({}).href).toBe('https://lab.mindvest.ai/scriptlens');
  });
  it('a local one for development, also from a packaged app', () => {
    expect(resolveLabUrl({ argv: ['--lab-url=http://127.0.0.1:3457/scriptlens'], isPackaged: true }).href).toBe('http://127.0.0.1:3457/scriptlens');
    expect(resolveLabUrl({ env: { SCRIPTLENS_URL: 'http://localhost:3000' } }).href).toBe('http://localhost:3000/scriptlens');
  });
  it('a packaged app refuses any other site', () => {
    expect(resolveLabUrl({ argv: ['--lab-url=https://evil.example/scriptlens'], isPackaged: true }).href).toBe('https://lab.mindvest.ai/scriptlens');
    expect(resolveLabUrl({ argv: ['--lab-url=http://192.168.0.2/scriptlens'], isPackaged: false }).href).toBe('https://lab.mindvest.ai/scriptlens');
  });
});

describe('where the main window may go', () => {
  it('stays under /scriptlens of the lab', () => {
    expect(navigationVerdict('https://lab.mindvest.ai/scriptlens?v=iG9CE55wbtY', LAB)).toBe('allow');
    expect(navigationVerdict('https://lab.mindvest.ai/scriptlens/anything', LAB)).toBe('allow');
  });
  it('the rest of the lab and other sites open in the browser', () => {
    expect(navigationVerdict('https://lab.mindvest.ai/', LAB)).toBe('external');
    expect(navigationVerdict('https://lab.mindvest.ai/scriptlens-other', LAB)).toBe('external');
    expect(navigationVerdict('https://www.youtube.com/watch?v=iG9CE55wbtY', LAB)).toBe('external');
    expect(navigationVerdict('http://lab.mindvest.ai/scriptlens', LAB)).toBe('external');
  });
  it('nothing else', () => {
    expect(navigationVerdict('file:///etc/passwd', LAB)).toBe('block');
    expect(navigationVerdict('javascript:alert(1)', LAB)).toBe('block');
    expect(navigationVerdict('not a url', LAB)).toBe('block');
  });
  it('the bridge answers only the ScriptLens page', () => {
    expect(bridgeAllowed('https://lab.mindvest.ai/scriptlens?v=x', LAB)).toBe(true);
    expect(bridgeAllowed('https://lab.mindvest.ai/promptcraft', LAB)).toBe(false);
    expect(bridgeAllowed('file:///Applications/ScriptLens.app/Contents/Resources/app/src/offline.html', LAB)).toBe(false);
  });
});

describe('input from the page', () => {
  it('video ids', () => {
    expect(VIDEO_ID_RE.test('k6i_4oGdx_E')).toBe(true);
    expect(VIDEO_ID_RE.test('k6i_4oGdx_E&x=1')).toBe(false);
    expect(VIDEO_ID_RE.test('short')).toBe(false);
  });
  it('tracks', () => {
    expect(readTrack({ language_code: 'zh-Hans', is_generated: false })).toEqual({ language_code: 'zh-Hans', is_generated: false });
    expect(readTrack({ language_code: 'es-419', is_generated: true })).toEqual({ language_code: 'es-419', is_generated: true });
    expect(readTrack({ language_code: 'ko"); alert(1); ("', is_generated: false })).toBeNull();
    expect(readTrack({ language_code: 'ko', is_generated: 'yes' })).toBeNull();
    expect(readTrack(null)).toBeNull();
  });
});

describe('latest.json', () => {
  it('versions', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });
  it('a newer version names this repository’s page — never another', () => {
    expect(readLatest({ version: '0.2.0', page: 'https://github.com/Eirene-dev/scriptlens-desktop/releases/tag/v0.2.0' }, '0.1.0')).toMatchObject({
      newer: true,
      page: 'https://github.com/Eirene-dev/scriptlens-desktop/releases/tag/v0.2.0',
    });
    expect(readLatest({ version: '0.2.0', page: 'https://evil.example/' }, '0.1.0').page).toBe(
      'https://github.com/Eirene-dev/scriptlens-desktop/releases/latest',
    );
    expect(readLatest({ version: '0.1.0' }, '0.1.0').newer).toBe(false);
    expect(readLatest({ version: 'soon' }, '0.1.0')).toBeNull();
    expect(readLatest(null, '0.1.0')).toBeNull();
  });
});
