# ScriptLens 데스크톱 — Stage 0 검증 (2026-11-23)

이 Mac(Apple Silicon, macOS 26.7.1)에서 Electron 44.3.0(praxis-desktop과 같은 버전)으로 돌렸다.
탐침: `probe/probe.mjs`, 파서: `probe/parse.mjs`. 실행 예: `npx electron probe/probe.mjs BrGX9tEMbnw --lang=ko --compare`.

> **주의 — UA를 바꾸지 않는다.** Electron 기본 UA로는 PoToken이 통과하고, UA에서 `Electron/x`를 지워 Chrome처럼 보이게 하면
> 약 절반이 거부된다(아래 "실험에서 알게 된 것" 1). 앱(`src/captions/fetcher.mjs`)은 UA 문자열을 그대로 둔다. README의 알려진 한계에도 적었다.

## 결론

- **1순위(플레이어가 직접 /api/timedtext를 부르게 하고 CDP로 본문 읽기)가 된다.** 수동·자동 생성·다국어 모두 성공했고,
  광고가 없으면 영상당 **2.3~2.9초**가 걸린다(페이지 정보 약 1.1~1.5초 + 자막 약 1.2초).
- 기존 FastAPI(youtube-transcript-api) 결과와 **구간 단위로 완전히 같다**(text·start·duration 모두): 영어 427/427,
  한국어 수동 156/156·429/429, 일본어 157/157, 한국어 자동 생성 337/337.
- 2순위(스크립트 패널)도 되지만(약 1.9초) **요청한 언어를 따르지 않고, 시각이 초 단위이며, 문장이 문단으로 묶인다.**
  비상용으로만 쓴다.

## 테스트 영상

| 경우 | 영상 ID | 트랙 | 결과 | 시간 |
|---|---|---|---|---|
| 한국어 수동 (+여러 언어) | `BrGX9tEMbnw` 세바시 | zh-Hans·ja·ko 수동, ko 자동 | 1순위, 156구간, 서버와 동일 | 2.7초 |
| 한국어 수동 | `SWzyztkoagc` 슈카월드 | ko 수동, ko 자동 | 1순위, 429구간, 서버와 동일 | 2.4초 |
| 한국어 자동 생성 | `k6i_4oGdx_E` 슈카월드 | ko 자동만 | 1순위, 337구간, 서버와 동일 | 2.5~2.9초 |
| 같은 영상의 자동 생성 | `BrGX9tEMbnw` ko 자동 | | 1순위, 202구간 (서버는 수동만 줘서 비교 불가) | 2.7초 |
| 여러 언어 중 하나 | `BrGX9tEMbnw` ja | | 1순위, 157구간, 서버와 동일 | 2.8초 |
| 영어 (65개 언어) | `iG9CE55wbtY` TED | en 수동 등 65개 | 1순위, 427구간, 서버와 동일 | 2.3~2.6초 |
| 광고가 먼저 | `iG9CE55wbtY` (광고는 무작위로 나옴) | | 15초 광고가 끝난 뒤 1순위, 427구간, 서버와 동일 | 16.9초 |
| 자막 없음 | `lzmSKX5TF3g` 화이트 노이즈 | 없음 | `no_transcript` | 1.3초 |
| 없는 영상 | `aaaaaaaaaaa` | | `unavailable` (ERROR · This video is unavailable) | 0.7초 |
| 네트워크 끊김 | (죽은 프록시로 재현) | | `network` (net::ERR_PROXY_CONNECTION_FAILED) | 4.1초 |
| 시간 초과 | (`--timeout=1200`) | | `timeout` | 1.3초 |

연령 제한·비공개 영상은 ID를 확보하지 못해 실제로 돌려 보지 못했다. 분류는 `playabilityStatus`
(status·reason)로 한다: `LOGIN_REQUIRED`/`AGE_*`/"confirm your age"/"not a bot" → `login_required`,
"private"·`ERROR`·`UNPLAYABLE` → `unavailable`.

## 실험에서 알게 된 것 (코드에 반영)

1. **UA를 고치지 않는다.** UA에서 `Electron/x`를 지워 Chrome처럼 보이게 하면 PoToken의 약 절반이 거부됐다
   (`pot`가 붙은 요청이 빈 200). Electron 기본 UA로는 40회 넘게 한 번도 거부되지 않았다. 거부된 토큰은 90바이트,
   통과한 토큰은 88바이트로 길이가 달랐다. UA 문자열과 브라우저의 나머지 특성이 어긋나는 것을 BotGuard가 잡는 것으로 보인다.
   브라우저 지문을 위장하는 쪽은 택하지 않았다.
2. **CDP 부착 시점은 상관없다.** 처음부터 붙여도 6/6, 토큰 확인 뒤에 붙여도 6/6이었다(기본 UA 기준).
3. **첫 자막 요청은 토큰 없이 나가서 빈 응답을 받는다.** 트랙을 껐다 켜면 플레이어가 그사이 만든 토큰으로 다시 요청한다.
   매번 1회 재토글로 끝났다.
4. **자동 생성 트랙은 `getOption('captions','tracklist',{ includeAsr: true })`라야 목록에 나온다.**
5. **광고에도 자막이 있다.** 한국어 광고의 ko 자동 자막(6구간)을 본 영상 자막으로 받은 적이 있다. 그래서 광고가 나오는 동안에는
   트랙을 건드리지 않고, 플레이어의 현재 영상이 요청한 ID일 때만 켜며, 응답 URL의 `v=`가 요청한 ID인 것만 받는다.
   고친 뒤에는 실제 광고 상황을 다시 만나지 못했다(광고는 약 100번 로드에 3~4번). Stage 2 시험에서 다시 확인한다.
6. **광고는 숨은 창에서도 실시간으로 재생된다**(15초 광고 → 16.9초). 건너뛰기를 자동으로 누르지 않는다.
   광고 두 개가 이어지면 30초를 넘길 수 있다.
7. **스크립트 패널은 `/youtubei/v1/get_panel`이다**(예전 `get_transcript`가 아님). 새 화면(`PAmodern_transcript_view`)에는
   언어 메뉴가 없고, 보여 주는 트랙이 일정하지 않다(TED는 수동 영어, 세바시는 수동 ko가 있는데도 자동 ko).
8. **영구 세션은 YouTube의 "마지막 자막 설정"을 기억한다.** 다음 영상에서 플레이어가 그 언어(번역 포함)를 먼저 요청한다.
   `lang`·`kind`·`tlang`·`v`로 걸러서 영향은 없다.
9. **네트워크가 끊기면 YouTube 서비스 워커가 페이지 껍데기를 띄운다.** 로드 실패 이벤트가 오지 않을 수 있어서, 창 안 요청의
   네트워크 오류(`webRequest.onErrorOccurred`)를 모아 `network`로 분류한다.
10. 숨은 페이지의 언어 선호를 `en-US`로 둔다. 트랙 이름이 기존 API와 같아지고("Korean (auto-generated)"),
    오류 사유를 읽을 수 있다(OS 언어를 따르면 "이 동영상은 볼 수 없습니다.").

## 지금 lab API가 프론트엔드에 주는 형태

`app/api/scriptlens/transcript/[...path]/route.ts`는 FastAPI 응답을 그대로 넘긴다.

- `GET /api/scriptlens/transcript/{id}/languages` → `200 { video_id, tracks: LanguageTrack[] }`
  - `LanguageTrack = { language: "Korean (auto-generated)", language_code: "ko", is_generated: true, is_translatable: true }`
- `GET /api/scriptlens/transcript/{id}?lang=ko` → `200 TranscriptData`
  - `{ video_id, language, language_code, is_generated, snippets: { text, start, duration }[] }` (초 단위, 소수 셋째 자리)
  - 같은 언어에 수동·자동이 다 있으면 **수동을 준다**(youtube-transcript-api의 find_transcript).
- 오류: `404 { detail: "Transcripts disabled for this video" | "Video unavailable" | "Requested language not available" }`,
  `503 { detail: "Upstream blocked: IpBlocked" }`, 프록시 자체 오류 `500/502 { error }`.
  `fetchJson`이 `detail || error`를 메시지로 던지고, 화면은 "언어 목록 조회 실패: …"로 보인다.
- 기존 화면의 언어 select는 `value = language_code`라서, 수동이 있는 언어의 자동 생성 트랙을 골라도 수동이 온다.

## 브리지 계약 제안 (`window.scriptlensNative`)

```ts
type NativeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 'no_transcript' | 'login_required' | 'unavailable' | 'timeout' | 'network' | 'busy' | 'bad_request';
      message: string };  // message는 화면에 그대로 쓸 한국어

interface ScriptLensNative {
  readonly appVersion: string;
  listTracks(videoId: string): Promise<NativeResult<{ video_id: string; title: string | null; tracks: LanguageTrack[] }>>;
  getTranscript(videoId: string, track: { language_code: string; is_generated: boolean }):
    Promise<NativeResult<TranscriptData & { source: 'timedtext' | 'panel' }>>;
}
```

- `LanguageTrack`·`TranscriptData`는 지금 타입 그대로다. 구간 값도 기존 API와 같다(위 비교).
- 오류는 throw 대신 값으로 돌려준다. contextBridge를 건너면 Error의 `code`가 사라지기 때문이다. 프론트엔드의 작은 어댑터가
  `ok: false`를 지금처럼 `Error(message)`로 바꿔 던지면 page.tsx의 흐름은 그대로 유지된다.
- 트랙은 `language_code`와 `is_generated`로 고른다. select의 value를 `ko:asr`/`ko:manual`처럼 바꾸면 자동 생성 트랙을 고를 수 없던
  문제도 함께 풀린다(프론트엔드 변경 몇 줄).
- 2순위(패널) 결과는 `source: 'panel'`, `language_code: 'panel'`, `language: 'YouTube 스크립트 패널'`로 돌려준다.
  패널의 언어·종류는 확실하지 않아서, 실제 트랙의 저장 슬롯(`scriptlens:doc:{id}:{lang}`)에 섞이지 않게 하려는 것이다.
- 앱 쪽 구현: `listTracks`가 연 숨은 창을 같은 영상의 `getTranscript`가 이어 쓴다(약 60초 유지, 그 뒤 닫음).
  한 번에 한 영상만 처리하고, 다른 영상 요청이 오면 `busy`를 돌려주거나 줄을 세운다. 전체 시간 제한은 광고(15초)를 감안해 40초로 두고,
  남은 시간이 6초 아래로 떨어지면 패널로 넘어간다.

## 주의: 기존 서버 상태

비교 도중(2026-11-23 17:33~18:07 KST, 자막 본문 요청 약 20회) 기존 서버의 자막 본문 요청이 `503 Upstream blocked: IpBlocked`로 바뀌었다
(언어 목록은 계속 됨). YouTube가 iwin 서버 IP를 막은 것이다. 지금 운영 중인 lab.mindvest.ai/scriptlens의 자막 가져오기도
같은 이유로 실패한다. 이후 서버 호출은 멈췄다.
