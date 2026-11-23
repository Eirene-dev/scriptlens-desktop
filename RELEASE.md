# 릴리스 절차

설치 파일과 `latest.json`은 이 저장소(공개, `Eirene-dev/scriptlens-desktop`)의 **GitHub Releases**에 둔다.
파일 이름에 버전을 넣지 않으므로, lab 페이지의 내려받기 링크(`…/releases/latest/download/<이름>`)는 새 버전에도 그대로 쓴다.

| 파일 | 만드는 곳 |
|---|---|
| `ScriptLens-mac-arm64.dmg` · `ScriptLens-mac-x64.dmg` (+ 같은 이름의 `.zip`, `SHA256SUMS-mac.txt`) | 이 Mac — `npm run dist:mac` (praxis-desktop 방식, ad-hoc 서명) |
| `ScriptLens-win-x64-setup.exe` (+ `SHA256SUMS-win.txt`) | GitHub Actions의 Windows runner — 태그를 올리면 `.github/workflows/windows.yml`이 만들어 **아티팩트로만** 둔다. 실제 Windows PC에서 확인한 뒤 그 파일을 손으로 릴리스에 붙인다 |
| `latest.json` | 이 Mac — `npm run latest-json` · **맨 마지막에** 올린다 |

앱은 시작할 때 `releases/latest/download/latest.json`을 읽어, 자기보다 높은 버전이면 내려받기 페이지를 안내한다.
"latest"는 **게시된**(draft가 아닌) 가장 최근 릴리스다. 그래서 게시하는 순간 모든 앱에 안내가 뜬다.

## 처음 한 번

1. GitHub에 공개 저장소 `Eirene-dev/scriptlens-desktop`을 만든다(빈 저장소).
2. `git remote add origin git@github.com:Eirene-dev/scriptlens-desktop.git && git push -u origin main`
3. (선택) `brew install gh && gh auth login` — 아래 업로드를 명령으로 할 때. 없으면 웹 화면에서 끌어다 놓는다.

## 매 릴리스

1. **버전 올리기** — `npm version 0.1.1 --no-git-tag-version` → `git commit -am "0.1.1"`
2. **검사** — `npm test`
3. **Mac 빌드** — `npm run dist:mac` → `out/dist/`에 dmg·zip(Apple Silicon·Intel)과 `SHA256SUMS-mac.txt`
   - 확인: `out/mac-arm64/ScriptLens.app/Contents/MacOS/Electron --smoke-test=out/smoke` → `out/smoke/smoke.json`의 `ok: true`, `bridge: "object"`
   - 이 Mac(Apple Silicon, Rosetta 없음)에서는 Intel 빌드를 실행해 볼 수 없다. 구조(아키텍처·서명·fuse)만 스크립트가 확인한다.
4. **태그 올리기 → Windows 빌드** — `git tag v0.1.1 && git push origin main v0.1.1`
   - Actions가 검사 → 설치 파일 빌드 → 압축 해제본과 설치본을 각각 실행해 창이 뜨는지 확인 → 아티팩트 `scriptlens-windows`
     (설치 파일, `SHA256SUMS-win.txt`, `smoke/*/smoke.png` 창 화면). **릴리스에는 붙이지 않는다.**
   - Actions에서는 자막 가져오기를 시험하지 않는다(데이터센터 IP는 YouTube가 막을 가능성이 크다).
5. **실제 Windows PC 확인** — 아티팩트의 설치 파일로 아래 목록을 본다. 통과하면 그 파일을 6에서 함께 붙인다.
   아직이면 Mac만 게시하고(6~8), Windows는 확인한 뒤 9로 붙인다.
6. **릴리스 만들기(draft)** — 태그 `v0.1.1`, 제목 `ScriptLens v0.1.1`. 붙일 것: `out/dist/ScriptLens-mac-*.dmg` · `*.zip` ·
   `SHA256SUMS-mac.txt` (+ 확인을 마친 Windows 설치 파일 · `SHA256SUMS-win.txt`). 웹 화면(Releases › Draft a new release)에
   끌어다 놓거나 `gh release create v0.1.1 --draft --title "ScriptLens v0.1.1" --notes "…" out/dist/ScriptLens-mac-* out/dist/SHA256SUMS-mac.txt`
7. **latest.json** — `npm run latest-json -- --notes "바뀐 것 한두 줄"` → `out/dist/latest.json`을 **마지막으로** 붙인다.
   Windows 설치 파일이 아직 없으면 `--mac-only`(9에서 Windows를 붙일 때 플래그 없이 다시 만들어 바꿔 넣는다).
8. **게시** — draft를 게시한다(Latest로 표시). 확인:
   `curl -sL https://github.com/Eirene-dev/scriptlens-desktop/releases/latest/download/latest.json`
   이전 버전 앱을 열어 새 버전 안내가 뜨는지 본다.
   (v0.1.0: 소유자 결정(2026-11-23)으로 Windows를 실제 PC 확인 **전에** '베타'로 공개했다 — 확인을 마치면 lab `desktop.ts`의
   `winBeta`를 false로 바꿔 배포한다.)
9. **Windows를 나중에 붙일 때** — 확인을 마친 설치 파일과 `SHA256SUMS-win.txt`를 게시된 릴리스에 붙이고(웹 화면의 Edit, 또는
   `gh release upload v0.1.1 ScriptLens-win-x64-setup.exe SHA256SUMS-win.txt`), `latest.json`을 플래그 없이 다시 만들어 바꿔 넣고, lab의
   `app/(tool-shell)/scriptlens/_lib/desktop.ts`에서 `winX64`를 링크로 바꿔 배포한다(지금은 null — '준비 중'으로 보인다).
   그 뒤 판부터는 두 플랫폼을 다 붙인 다음 게시한다: Mac만 있는 새 판을 게시하면 Windows 앱이 새 버전 안내를 받고도 받을 파일이 없다.

YouTube가 바뀌어 자막 가져오기가 멈췄을 때도 같은 절차다. 고친 버전을 내면 사용자는 앱을 열 때 안내를 받는다.

## 실제 Windows PC 확인 (릴리스마다, 또는 처음 한 번)

- [ ] 설치 파일을 받아 실행 → SmartScreen "Windows의 PC 보호" → **추가 정보 → 실행** → 설치되고 시작 메뉴에 ScriptLens가 생긴다
- [ ] 앱이 lab.mindvest.ai/scriptlens를 띄운다. 화면에 붙여넣기 칸이 아니라 URL 칸이 보인다(브리지 인식)
- [ ] 한국어 수동 자막·자동 생성 자막이 있는 영상에서 언어 목록 → 가져오기가 된다(같은 영상의 다른 트랙으로 바꾸기도)
- [ ] 광고가 나오는 영상에서: 10초 안에 끝나면 고른 트랙이, 더 길면 'YouTube 스크립트 패널' 판이 들어온다(광고 자막이 아니라 본 영상 것)
- [ ] 자막 없는 영상 → "이 영상에는 자막이 없습니다."
- [ ] 인터넷을 끊고 앱을 열면 안내 화면, 다시 연결하면 저절로 다시 열린다
- [ ] lab 홈 등 다른 링크는 기본 브라우저로 열린다
- [ ] 편집 → 앱을 닫았다 열어도 문서가 남아 있다
- [ ] 제어판 › 앱에서 제거된다
- [ ] `%APPDATA%\ScriptLens\logs\scriptlens.log`에 시간·결과만 남는다

## Mac 첫 실행 (사용자 안내와 같은 내용)

dmg를 열어 ScriptLens를 응용 프로그램으로 끌어다 놓고 연다 → "Apple은 ScriptLens에 … 확인할 수 없습니다" →
**시스템 설정 › 개인정보 보호 및 보안**의 아래쪽 "ScriptLens이(가) 차단되었습니다" 옆 **그래도 열기** → 한 번 더 확인.
Apple Silicon(M1 이후)은 `arm64`, Intel Mac은 `x64`를 받는다(Apple 메뉴 › 이 Mac에 관하여 › 칩/프로세서).
