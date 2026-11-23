// No automatic update (an unsigned Mac app cannot replace itself properly). At start the app reads latest.json from the
// latest GitHub release; when it names a newer version, a dialog offers the download page. YouTube changes are fixed by
// a new version of this app, so the notice matters.

import { dialog, net, shell } from 'electron';
import { LATEST_JSON_URL, RELEASES_PAGE } from './config.mjs';
import { readLatest } from './policy.mjs';

/**
 * @param {{ window: Electron.BrowserWindow | null, currentVersion: string, interactive?: boolean, url?: string, log?: Function }} o
 *   interactive — from the menu: also say so when this is the newest, or when the check failed
 */
export async function checkForUpdate({ window, currentVersion, interactive = false, url = LATEST_JSON_URL, log = () => {} }) {
  let latest = null;
  try {
    const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (res.ok) latest = readLatest(await res.json(), currentVersion);
    log('update-check', { status: res.status, latest: latest?.version ?? null });
  } catch (e) {
    log('update-check', { error: String(e?.message ?? e) });
  }
  const parent = window && !window.isDestroyed() ? window : undefined;
  if (latest?.newer) {
    log('update-offered', { latest: latest.version, current: currentVersion });
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'ScriptLens 새 버전',
      message: `새 버전 ${latest.version}이 나왔습니다. (지금 ${currentVersion})`,
      detail:
        'YouTube가 바뀌면 자막 가져오기가 멈출 수 있어, 새 버전을 내려받아 설치해 주세요.' +
        (latest.notes ? `\n\n${latest.notes}` : ''),
      buttons: ['내려받기 페이지 열기', '나중에'],
      defaultId: 0,
      cancelId: 1,
    });
    log('update-answer', { open: response === 0 });
    if (response === 0) await shell.openExternal(latest.page);
    return;
  }
  if (!interactive) return;
  if (latest) {
    await dialog.showMessageBox(parent, { type: 'info', title: 'ScriptLens', message: `최신 버전입니다 (${currentVersion}).`, buttons: ['확인'] });
  } else {
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'ScriptLens',
      message: '새 버전을 확인하지 못했습니다.',
      detail: '네트워크를 확인하거나, 내려받기 페이지에서 직접 확인해 주세요.',
      buttons: ['내려받기 페이지 열기', '닫기'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await shell.openExternal(RELEASES_PAGE);
  }
}
