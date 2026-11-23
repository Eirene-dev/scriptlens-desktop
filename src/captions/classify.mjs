// Results the bridge hands the page: { ok: true, data } or { ok: false, code, message }.
// The codes are the contract's (lab _lib/native.ts); the messages are shown as they are.

export const MESSAGES = {
  no_transcript: '이 영상에는 자막이 없습니다.',
  no_track: '고른 자막 트랙을 이 영상에서 찾지 못했습니다.',
  login_required: '로그인이 필요한 영상이라 자막을 가져올 수 없습니다.',
  age: '연령 확인이 필요한 영상이라 로그인 없이 자막을 가져올 수 없습니다.',
  bot: 'YouTube가 이 PC의 접속을 확인하고 있습니다(로봇 확인). 잠시 뒤 다시 시도해 주세요.',
  members: '채널 회원 전용 영상이라 자막을 가져올 수 없습니다.',
  unavailable: '볼 수 없는 영상입니다. 삭제되었거나 주소가 잘못되었을 수 있습니다.',
  private: '비공개 영상입니다.',
  region: '이 지역에서 볼 수 없는 영상입니다.',
  live_offline: '아직 시작하지 않았거나 끝난 라이브 방송입니다.',
  timeout: '시간 안에 자막을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요. 계속되면 앱을 최신 버전으로 받아 주세요.',
  network: '네트워크에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.',
  busy: '다른 영상을 가져오기 시작해 이 요청은 멈췄습니다.',
  bad_request: '영상 ID 또는 자막 트랙의 형식이 올바르지 않습니다.',
  not_here: '이 화면에서는 자막 가져오기를 쓸 수 없습니다.',
};

const CODE_OF = {
  no_track: 'no_transcript',
  age: 'login_required',
  bot: 'login_required',
  members: 'login_required',
  private: 'unavailable',
  region: 'unavailable',
  live_offline: 'unavailable',
  not_here: 'bad_request',
};

/** fail('age') → { ok: false, code: 'login_required', message: '연령 확인이 …' } */
export function fail(key) {
  return { ok: false, code: CODE_OF[key] ?? key, message: MESSAGES[key] ?? MESSAGES.timeout };
}

export const ok = (data) => ({ ok: true, data });

/** net::ERR_… that mean "no network", as webRequest and loadURL report them */
export const NET_ERR =
  /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|TIMED_OUT|NETWORK_\w+|ADDRESS_UNREACHABLE|PROXY_\w+|TUNNEL_\w+|SSL_\w+|CERT_\w+|EMPTY_RESPONSE|QUIC_\w+)/;

/**
 * The page's playabilityStatus → null when the video plays, else the failure.
 * The hidden page asks for English (Accept-Language en-US), so the reasons are read in English.
 */
export function classifyPlayability(info) {
  const s = info?.status ?? null;
  if (s === 'OK') return null;
  const r = `${info?.reason ?? ''} ${info?.subreason ?? ''}`;
  if (s === 'LIVE_STREAM_OFFLINE') return fail('live_offline');
  if (/^AGE_/.test(s ?? '') || /confirm your age|age-restricted|inappropriate for some users/i.test(r)) return fail('age');
  if (/not a bot/i.test(r)) return fail('bot');
  if (/private/i.test(r)) return fail('private');
  if (/members-only|join this channel|channel members/i.test(r)) return fail('members');
  if (s === 'LOGIN_REQUIRED' || s === 'CONTENT_CHECK_REQUIRED') return fail('login_required');
  if (/country|your region|not available in/i.test(r)) return fail('region');
  return fail('unavailable');
}

/** caption tracks as the lab page knows them (LanguageTrack) */
export const toTracks = (raw) =>
  (raw ?? []).map((t) => ({
    language: t.name,
    language_code: t.languageCode,
    is_generated: t.kind === 'asr',
    is_translatable: !!t.isTranslatable,
  }));
