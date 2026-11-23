# ScriptLens 데스크톱

[lab.mindvest.ai/scriptlens](https://lab.mindvest.ai/scriptlens)를 창 하나에 띄우고, **YouTube 자막 가져오기 하나만** 맡는 Mac·Windows 앱이다.
화면은 웹 페이지 그대로라서 화면 수정은 lab의 웹 배포로 끝난다. 서버는 없다.

- 일반 브라우저에서 ScriptLens는 붙여넣기로 쓴다. 앱 안에서는 URL만 넣으면 자막 언어를 골라 가져온다.
- 자막은 숨은 창에서 실제 YouTube 영상 페이지를 열어, **YouTube 자신의 플레이어가 받아 온 자막 응답을 읽는다.**
  이 코드는 YouTube에 직접 요청을 보내지 않는다(Python·youtube-transcript-api를 쓰지 않음). 검증 기록은 [STAGE0.md](STAGE0.md).
- 내려받기: [Releases](https://github.com/Eirene-dev/scriptlens-desktop/releases/latest). 배포 절차는 [RELEASE.md](RELEASE.md).

## 구조

| 파일 | 하는 일 |
|---|---|
| `src/main.mjs` | 메인 창(lab 페이지), 이동 제한, 오프라인 안내, 브리지 IPC, 메뉴, 업데이트 확인 |
| `src/preload.cjs` | `window.scriptlensNative` — `appVersion`, `listTracks(videoId)`, `getTranscript(videoId, track)`만 노출. lab 출처에서만 |
| `src/captions/fetcher.mjs` | 숨은 YouTube 창: 트랙 켜기 → `/api/timedtext` 응답 읽기, 실패 시 스크립트 패널. 한 번에 한 영상 |
| `src/captions/*.mjs` | 파서, 응답 판별(영상 ID·트랙·번역 여부), 오류 분류, 광고 동안 멈추는 시간 제한, 페이지에서 돌리는 작은 스크립트 |
| `src/policy.mjs` | 창이 갈 수 있는 주소, 브리지를 쓸 수 있는 쪽, 입력 검사, latest.json 읽기 (순수 함수) |
| `src/update.mjs` | 시작할 때 latest.json → 새 버전이면 내려받기 페이지 안내 (자동 업데이트는 없음) |
| `src/offline.html` | 오프라인이거나 lab에 접속할 수 없을 때 |
| `probe/` | Stage 0 탐침 (기록용) |

브리지 계약(응답 형태·오류 코드)은 lab의 `app/(tool-shell)/scriptlens/_lib/native.ts`와 같다.
오류는 throw가 아니라 `{ ok: false, code, message }` 값으로 돌려준다.

## 보안

- 메인 창: `contextIsolation`·`sandbox` 켜짐, `nodeIntegration` 꺼짐. lab의 `/scriptlens` 아래로만 이동하고, 다른 링크·새 창은 기본 브라우저로 연다.
- 브리지는 lab 출처의 메인 프레임에서만 응답한다(preload와 메인 프로세스 양쪽에서 확인). 영상 ID(11자)와 트랙(언어 코드 형식·불리언)을 검사한다.
- 숨은 YouTube 창: preload 없음, 음소거, 별도 세션(`persist:scriptlens-youtube`), 권한 요청 모두 거부, YouTube 밖으로 이동 금지, 새 창 금지.
- 패키징한 앱은 Node fuse(RunAsNode·NODE_OPTIONS·inspect 인자)를 닫는다. `--lab-url`은 로컬 http 주소만 받는다.
- 로그(`~/Library/Logs/ScriptLens/scriptlens.log`, Windows는 `%APPDATA%\ScriptLens\logs`)에는 요청·시간·결과만 남고, 자막 내용과 토큰은 남기지 않는다.

## 개발

```sh
npm install
npm test                       # 단위 검사 (fixture — YouTube에 요청하지 않음)
npm run dev                    # 로컬 lab(http://127.0.0.1:3457/scriptlens)을 띄운 앱
npm start                      # 운영 lab을 띄운 앱
npx electron . --selftest=<videoId>:<lang>[:asr]   # UI 없이 가져오기 모듈만 (개발 빌드에서만)
npx electron . --smoke-test=<dir>                  # 창을 띄우고 smoke.json·smoke.png를 남기고 종료
```

개발 빌드에서만 듣는 환경변수: `SCRIPTLENS_FORCE_PANEL=1`(2순위만), `SCRIPTLENS_NO_EXTERNAL=1`(외부 링크를 열지 않고 로그만),
`SCRIPTLENS_UPDATE_URL`(다른 latest.json).

YouTube 시험 요청은 줄인다. 같은 IP에서 자막 본문 약 20회 만에 서버가 막힌 적이 있다(STAGE0.md). 로직은 fixture로 검사하고,
실제 요청은 영상마다 한 번, 간격을 두고 한다.

## 동작과 수치 (2026-11-23, Apple Silicon Mac)

- 광고가 없으면 언어 목록 약 1.2~2.3초, 자막 약 0.2~1.4초. 같은 영상의 다른 트랙은 열린 창을 다시 써서 0.2~0.3초.
- 첫 자막 요청은 토큰 없이 나가 빈 응답을 받는다. 트랙을 껐다 켜면 플레이어가 PoToken을 붙여 다시 요청한다.
- 광고에도 자막이 있다. 광고 중에는 트랙을 건드리지 않고, 응답 URL의 `v=`가 요청한 영상인 것만 받는다.
- 광고가 나오는 동안에는 시간 제한(40초)이 멈추고, 전체 상한은 90초다.
- **광고가 10초를 넘기면 기다리지 않고 스크립트 패널로 받는다.** 패널은 플레이어가 아니라 페이지의 것이라 광고 중에도 열린다
  (52초 광고 10.1초째에 넘어가 광고가 재생되는 채로 0.16초 만에 받음, 2026-11-23). 패널이 10초 안에 오지 않으면 광고를 마저 기다린다.
- 건너뛰기 버튼 누르기(`LIMITS.pressSkip`)는 **꺼 두었다**(첫 배포 결정). 코드는 남아 있다. 켜면 YouTube가 **건너뛰기** 버튼을
  보일 때 그 버튼만 누른다. 누르기 직전에 그 좌표의 맨 위 요소가 버튼인지 확인하고, 스크립트의 `click()`은 YouTube가 무시해서
  DevTools 프로토콜의 마우스 입력을 쓴다(15초 광고가 5.4초에 넘어갔다).
- 1순위가 안 되면 스크립트 패널(`/youtubei/v1/get_panel`)로 받는다. 언어는 YouTube가 정한 것이고, 시각은 초 단위이며,
  문장이 문단으로 묶인다. 화면에 그렇게 표시하고 저장 슬롯은 `panel`이다.

## 알려진 한계

- **UA를 바꾸지 않는다.** Electron 기본 UA로는 PoToken이 통과하지만, UA에서 `Electron/x`를 지워 Chrome처럼 보이게 하면 약 절반이 거부된다(STAGE0.md).
  YouTube가 이 판정을 바꾸면 자막 가져오기가 멈출 수 있다. 그때는 앱을 고쳐 새 버전을 낸다(시작할 때 새 버전 안내가 뜬다).
- YouTube 페이지 구조(플레이어 API, 스크립트 패널)에 기대므로 YouTube가 바뀌면 고쳐야 한다.
- 연령 제한·회원 전용·로그인 필요 영상은 가져오지 못한다(로그인하지 않는다). 비공개·삭제 영상도 마찬가지.
- 광고가 10초를 넘기면 결과가 패널 판(YouTube가 정한 언어, 초 단위 시각, 문단 묶음)이 된다. 고른 언어로 받으려면 광고가 끝난 뒤
  같은 영상의 트랙을 다시 고른다(창이 1분 동안 열려 있어 바로 받는다). 패널마저 안 되면 상한(90초)까지 광고를 기다린다.
- 앱과 브라우저는 저장 공간이 따로다. 브라우저에서 편집하던 문서는 앱에 보이지 않는다.
- EU처럼 YouTube 동의 화면이 먼저 뜨는 지역은 시험하지 않았다(동의 화면이 뜨면 시간 초과로 끝날 수 있다).
- 서명하지 않은 앱이다. Mac은 처음 열 때 시스템 설정 > 개인정보 보호 및 보안에서 '그래도 열기', Windows는 SmartScreen에서 '추가 정보 → 실행'.
- 숨은 창은 자막을 받는 동안 영상을 음소거로 재생한다(받은 뒤 일시정지, 1분 뒤 닫음). 그동안 영상 데이터를 내려받는다.
