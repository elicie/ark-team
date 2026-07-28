# SLICE-017 결정론적 UI 런타임 보완 명세

- Spec identity: `ark-team-verification-ui-runtime-v1.0.2`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Delta status: `SPEC_DELTA_APPLIED`
- Supersedes: `ark-team-verification-ui-runtime-v1.0.1`
- Authority date: 2026-07-28 UTC
- Authority: 사용자가 요청한 실제 UI QA 실행 기능, Backend/UI 독립 실행
  요구, `verification-spec-v4`, 그리고 이 보완안으로 진행하라는 사용자 승인
- Target source:
  `GIT-COMMIT:8dcea3d5a117f1197b8fee3d33808bfa9406372d`
- Target tree: `5d18c1cdfcd93de147b0470577532c84d5504c4e`
- Parent contract: `docs/slices/SLICE-017.md`
  (`verification-spec-v4`)
- Parent host-token override: 이 보완 명세에서 parent의 로컬 hostname
  `dev`는 `devbox`로 읽는다. Parent 문서 bytes와 package fingerprint는
  바꾸지 않으며 이 override는 아래 승인 SPEC SHA-256으로 검증한다.
- Reference boundary: `NONE`
- Deliverable: 이 문서 package만 작성하며 제품 코드나 의존성을 변경하지 않는다.

## 1. 목적과 완료 신호

현재 기본 검증 게이트는 Backend `curl` QA만 실사용 경로에 연결하고, UI가
활성화되면 정확한 실행 계약이 없다는 이유로 `SPEC_DELTA_REQUIRED`를
기록한다. 이 문서는 기존 schema-2 browser/screenshot/comparison evidence
계약을 바꾸지 않고 생산용 Playwright 실행기를 연결하는 다음 구현
슬라이스 `IS-1708`을 닫는다.

완료 신호는 다음과 같다.

1. Backend-only 동작은 그대로 유지된다.
2. 승인된 UI 설정은 저장소에 고정된 Playwright와 번들 Chromium만 사용한다.
3. 결정론적 UI action/assertion, 세 viewport PNG, 기존 비교기가 실제 로컬
   서버를 대상으로 실행된다.
4. 누락된 Playwright, 브라우저, 승인 baseline 또는 환경 불일치는 설치나
   대체 없이 fail-close한다.
5. Browser Use, Playwright agent CLI/MCP, Stagehand 결과는 UI 통과 근거가
   되지 않는다.

## 2. 근거와 탐색 범위

### 2.1 저장소와 로컬 환경

| Evidence | 관측 | 결론 |
| --- | --- | --- |
| `UIR-EVID-001` | `verification-local-runtime.ts`가 browser와 screenshot을 `unavailable-v1`로 등록하고 UI 활성화를 `SPEC_DELTA_REQUIRED`로 차단한다. | 생산 UI 실행기는 아직 없다. |
| `UIR-EVID-002` | `verification-browser-adapter.ts`와 `verification-visual-adapter.ts`에 strict request/result, trace, PNG, 비교 계약이 이미 있다. | 새 coordinator나 새 QA 플랫폼은 필요 없다. |
| `UIR-EVID-003` | screenshot request는 `case_state = "after-declared-actions"`를 요구하지만 별도 browser request의 context를 전달받지 않는다. | 두 effect가 상태를 추론하거나 actions를 재실행하지 않도록 하나의 combined UI-case effect가 필요하다. |
| `UIR-EVID-004` | 기본 bootstrap 입력은 UI baseline PNG와 semantic checklist를 외부 호출자가 넣어야 한다. | 기본 PM 게이트가 승인 baseline store에서 읽는 production resolver가 필요하다. |
| `UIR-EVID-005` | 저장소 `package.json`과 lockfile에 Playwright 의존성이 없다. | 실행 중 자동 설치하지 말고 구현 commit에서 exact dependency를 추가한다. |
| `UIR-EVID-006` | Codex Playwright wrapper SHA-256은 `aa3fdff5d0e4556177f4dfd5f04117e772aa54f94b6a2e34b6c0edf629c6b9b5`이며 `npx --yes --package @playwright/cli`를 사용한다. | 버전이 고정되지 않은 agent CLI wrapper는 gate 실행기가 아니다. |
| `UIR-EVID-007` | 관측된 `@playwright/cli 0.1.17`은 alpha Playwright와 Chromium `151.0.7922.10`을 사용한다. | 안정판 browser identity와 일치하지 않는다. |
| `UIR-EVID-008` | 실제 서버 hostname은 사용자가 정정한 `devbox`이며 `100.95.211.34`로 해석된다. | 기존 `dev` token은 잘못 기록됐다. |
| `UIR-EVID-009` | 현재 bootstrap은 `runBrowserCase` 뒤 `runScreenshots`를 별도 호출하고 두 runtime contract는 context/state 전달 경로가 없다. | v1.0.0대로 구현하면 선언 action이 정상 UI gate에서 두 번 실행될 수 있으므로 combined execution으로 보정해야 한다. |
| `UIR-EVID-010` | screenshot v1 request/result는 각 capture URL을 action 전 초기 URL과 같게 강제한다. | same-origin navigation action 뒤 실제 화면을 증명하려면 검증된 browser `final_url`을 screenshot 기대 URL로 연결해야 한다. |
| `UIR-EVID-011` | coordinator ownership은 browser action에서 screenshot record 제출을 거부하고, 두 action 사이 in-memory result는 crash/reopen 때 사라진다. | Combined effect의 PNG/metadata를 먼저 등록 artifact로 내구성 있게 쓰고 screenshot action은 그 bytes를 strict-read해 record만 materialize해야 한다. |
| `UIR-EVID-012` | Chromium 151은 `http://dev:10091`을 HSTS로 HTTPS 승격해 HTTP 서버 요청 전 `ERR_SSL_PROTOCOL_ERROR`를 냈다. | `dev`는 승인 HTTP QA hostname으로 사용할 수 없다. |
| `UIR-EVID-013` | `0.0.0.0:10091` fixture와 유일한 `--host-resolver-rules=MAP devbox 127.0.0.1` argument로 Chromium이 `http://devbox:10091/`에서 HTTP 200, exact URL, heading을 확인했다. | `devbox`는 기존 HTTP/port/bind/network 계약을 바꾸지 않고 실행 가능하다. |
| `UIR-EVID-014` | Playwright `route.fetch/fulfill`로 navigation redirect를 선검사하면 같은 document의 정상 WebSocket이 연결되지 않았고, `route.continue`만 사용하면 cross-origin redirect 대상에 effect가 발생한 뒤 차단됐다. Chromium `Fetch.requestPaused`의 request-stage guard는 정상 local HTTP/WS를 통과시키면서 redirect HTTP와 external WS를 effect 전에 차단했다. | 시작한 exact Chromium target 내부의 request-stage guard가 HTTP(S) 경계를 소유하고 Playwright WebSocket route가 WS 경계를 중복 검증해야 한다. |

### 2.2 공식 reference

- Playwright stable:
  [v1.62.0](https://github.com/microsoft/playwright/releases/tag/v1.62.0),
  commit `e3950d9c140d007bd52853b45813c6274b24e36f`
- Stable browser provenance:
  [v1.62.0 browsers.json](https://raw.githubusercontent.com/microsoft/playwright/v1.62.0/packages/playwright-core/browsers.json),
  Chromium/headless-shell revision `1234`, version `151.0.7922.34`
- `@playwright/test@1.62.0` registry integrity:
  `sha512-9zOJ6ZQRAena31MpOH9VSzIz8Ou3YJ/wtY/eQm5T2uhfhG7/U3COrMS8xOtUrZrp9OgdmzEnIYODye3nY1VqzA==`
- Playwright contracts:
  [browser installation/version coupling](https://playwright.dev/docs/browsers),
  [isolated browser contexts](https://playwright.dev/docs/browser-contexts),
  [network routing](https://playwright.dev/docs/network),
  [service workers](https://playwright.dev/docs/service-workers),
  [auto-wait](https://playwright.dev/docs/actionability),
  [assertions](https://playwright.dev/docs/test-assertions),
  [tracing](https://playwright.dev/docs/api/class-tracing), and
  [screenshots](https://playwright.dev/docs/api/class-page#page-screenshot)
- Agent CLI:
  [`@playwright/cli v0.1.17`](https://github.com/microsoft/playwright-cli/releases/tag/v0.1.17),
  commit `793cfb32572733cbcb401e6f28d05a7a914ce408`
- Browser Use latest:
  [0.13.7](https://github.com/browser-use/browser-use/releases/tag/0.13.7),
  commit `f0aa3a8bb03779c71a5aa262d389e3bfe6b77cdc`
- Stagehand local TypeScript candidate:
  [`@browserbasehq/stagehand@3.7.0`](https://github.com/browserbase/stagehand/releases/tag/%40browserbasehq%2Fstagehand%403.7.0),
  commit `6f93b1e7e55577e668a3e2e94a2cc7270ed9765e`

공식 reference는 capability와 제약의 근거일 뿐 Ark Team 제품 동작의
authority가 아니며 설치·원격 실행을 승인하지 않는다.

## 3. 범위

### 포함

- 기존 default verification runtime의 UI capability 등록
- repo-local exact Playwright dependency와 stable bundled Chromium
- 결정론적 browser action/assertion 실행
- 세 viewport의 exact PNG 캡처
- 기존 read-only baseline 검증과 비교기에 필요한 production input 연결
- exact-origin HTTP(S)/WebSocket 차단
- trace, screenshot, process/context lifecycle 정리
- Backend-only 회귀와 UI fail-close 검증

### 제외

- Browser Use, Playwright agent CLI/MCP, Stagehand runtime 설치 또는 실행
- cloud browser/model, tunnel, proxy, persistent/real profile
- login, credential, storage-state, upload/download UI 시나리오
- baseline 생성·승인·갱신
- semantic image reviewer 구현
- generated/healed test 자동 적용
- Docker, 인프라, `/etc/hosts`, DNS 또는 시스템 설정 변경
- 기존 `verification-spec-v4` 문서 bytes나 package fingerprint 변경

## 4. 결정과 경고

### 승인 결정

- `UIR-DEC-001`: schema의 `deterministic_adapter = "playwright-cli"`는
  기존 Ark adapter key로 유지한다. Microsoft `@playwright/cli`, Codex
  wrapper, MCP 또는 shell 명령 조합을 실행하라는 뜻이 아니다.
- `UIR-DEC-002`: 생산 adapter identity는
  `playwright-cli / ark-ui-1.0.0-pw-1.62.0`, browser identity는
  `chromium-headless-shell-151.0.7922.34-r1234`로 고정한다.
- `UIR-DEC-003`: 구현 의존성은 exact
  `@playwright/test@1.62.0`과 lockfile이며 runtime은 library API를 직접
  import한다. QA 실행 중 `npm install`, `npx --package`, `latest`, range
  resolution을 하지 않는다. Browser provisioning은 별도 setup 단계에서
  exact locked CLI로 수행하며 runtime capability probe가 설치를 대신하지
  않는다.
- `UIR-DEC-004`: default PM gate는 browser case마다 screenshot capture를
  포함한 combined browser-driver effect를 호출한다. 이 effect가 local
  headless browser와 fresh context를 한 번 시작하고 `finally`에서 닫는다.
  daemon, persistent session, CDP attach, system Chrome을 재사용하지 않는다.
- `UIR-DEC-005`: combined effect는 `1440x900`에서
  navigation/readiness/ordered actions/deterministic assertions를 한 번
  실행한다. 같은 context에서 viewport layout만 `375x812`, `768x1024`,
  `1440x900` 순서로 바꾸고 readiness를 재확인해 캡처한다. 따라서 한
  bootstrap 정상 경로의 case당 declared action과 click/submit side effect는
  총 한 번이다.
- `UIR-DEC-006`: system resolver를 바꾸지 않고 유일한 Chromium launch
  argument `--host-resolver-rules=MAP devbox 127.0.0.1`을 사용한다. URL
  gate는 exact `http://devbox:<recorded-port>` origin을 검사한다.
- `UIR-DEC-007`: semantic review가 optional이면 unavailable 결과를
  보존하고 비교를 계속한다. required이면 기존 capability gate가
  `unavailable`로 닫는다.
- `UIR-DEC-008`: 승인 baseline은 읽기 전용으로 검증·로딩한다. 이번
  slice는 baseline bytes를 만들거나 바꾸지 않는다.
- `UIR-DEC-009`: combined effect는 기존 deterministic-browser retry
  ceiling인 두 번을 보존한다. Declared actions는 runtime attempt마다 한
  번이며 실패 뒤 retry는 같은 immutable input을 다시 실행할 수 있다.
  Exactly-once external mutation은 이 계약의 보장이 아니고 credential/data
  mutation 시나리오는 계속 제외한다.
- `UIR-DEC-010`: combined browser result가 same-origin 검증을 통과한
  `final_url`을 세 screenshot의 exact URL로 사용한다. Action 전 초기 URL,
  다른 screenshot URL 또는 cross-origin URL은 통과할 수 없다.
- `UIR-DEC-011`: combined browser attempt는 세 PNG와 canonical capture
  metadata를 등록 artifact root에 먼저 저장하고 browser record가 그
  reference를 소유한다. 이어지는 screenshot action은 해당 artifact를
  strict-read해 기존 screenshot evidence를 materialize할 뿐 browser를
  호출하지 않는다. In-memory-only handoff는 금지한다.
- `UIR-DEC-012`: `devbox` override는 신규 contract-v2 coordinator config,
  server snapshot/readiness, Backend API, deterministic UI, Next.js
  `allowedDevOrigins` 전체에 적용한다. 기존 schema-v1 `dev` records는
  read-only 호환을 유지한다.
- `UIR-DEC-013`: HTTP(S) exact-origin 경계는 새로 시작한 exact Chromium
  page target에 request-stage guard를 initial navigation 전에 설치한다.
  이는 외부/system browser에 attach하거나 persistent CDP session을
  재사용하는 동작이 아니다. WebSocket route는 같은 origin을 별도로
  검증하고 정상 연결만 server로 전달한다.

### 알려진 경고

- Playwright trace는 DOM/network 내용을 포함할 수 있고 공식 redaction
  옵션이 없다. 이번 범위는 credential 없는 로컬 fixture만 허용하고 trace를
  owner-only artifact로 보존하며 raw 내용을 구조화 record/log로 복제하지
  않는다.
- pixel 결과는 OS/font/rendering 환경에도 영향을 받는다. 기존 v4 baseline
  tuple과 strict byte comparison을 유지하며 mismatch를 자동 승인하거나
  baseline으로 승격하지 않는다.
- Next.js 프로젝트는 `allowedDevOrigins`에 `devbox`가 있음을
  별도 source inspection으로 증명해야 한다.
- 기존 deterministic-browser retry ceiling은 두 번이다. Combined effect는
  attempt 내부 중복을 제거하지만 첫 attempt가 effect 뒤 실패하면 immutable
  actions를 retry에서 다시 실행할 수 있으며 exactly-once mutation을
  보장하지 않는다.

## 5. 요구사항

### UIR-REQ-001 — Exact runtime identity

구현은 exact `@playwright/test@1.62.0`과 lockfile integrity를 사용한다.
capability discovery는 package version, bundled executable 존재, headless
launch, `browser.version() === "151.0.7922.34"`, configured adapter/browser
identity를 검사한다. 하나라도 다르면 browser와 screenshot은
`unavailable`이며 설치·fallback·system browser 탐색을 하지 않는다.
Setup은 `npx --no-install playwright install chromium`까지만 허용하며
system package를 바꾸는 `--with-deps`는 이 slice 범위가 아니다.

구현은 이 문서 `SPEC.md`의 승인 SHA-256을 상수로 포함하고 runtime
capability discovery 때 현재 bytes와 대조한다. Hash가 다르면
`PACKAGE_FINGERPRINT_MISMATCH`로 UI effect 전에 중단하고 관측 hash를
capability evidence에 기록한다. 기존 v4 package fingerprint와 source
fingerprint 검증은 그대로 함께 적용한다.

### UIR-REQ-002 — Local browser and network boundary

Browser는 `headless: true`, channel/executablePath/persistent profile/proxy
없이 실행한다. browser child environment에서 proxy와 credential 변수를
제거한다. context는 fresh/non-persistent이며 DPR `1`, locale `en-US`,
timezone `UTC`, light color scheme, reduced motion `no-preference`,
`serviceWorkers: "block"`, 빈 permissions, `acceptDownloads: false`를
사용한다.

새 page는 inert `about:blank` 상태에서 만들고 initial navigation 전에
Chromium request-stage HTTP(S) guard와 WebSocket route를 모두 활성화한다.
exact recorded origin만 통과하고 다른 host/scheme/port, cross-origin
redirect, `file:`, `chrome:`, external WebSocket은 effect 전에 차단한다.
초기 `about:blank`과 allowed-origin에서 생성된 non-network `data:`/`blob:`
만 허용한다.

### UIR-REQ-003 — Deterministic action and assertion mapping

모든 selector action은 strict Playwright Locator를 사용하고 `force`, fixed
sleep, evaluate, run-code, codegen, self-heal을 금지한다.

| Ark input | Playwright mapping |
| --- | --- |
| readiness / `wait_for_selector` | `locator.waitFor({ state: "visible" })` |
| `click` | `locator.click()` |
| `fill` | `locator.fill(value)` |
| `press` | `locator.press(key)` |
| `visible` | exact role/name locator의 visibility |
| `text` | Playwright string text equality의 whitespace normalization |
| `url` | recorded origin과 relative path를 결합한 exact URL |
| `value` | exact input value |
| `accessibility_snapshot` | `ariaSnapshot()` 반환 문자열의 raw UTF-8 SHA-256 |
| `response` | 초기 navigation 전에 listener를 등록하고 exact origin/path/status가 한 번 이상 관측됨 |

각 action/assertion/navigation은 60초, 전체 case는 120초 wall-clock
`AbortSignal`로 제한한다. console, page error, dialog, navigation, step
evidence는 기존 bound와 redaction을 따른다. Dialog는 기록 후 dismiss한다.

Production runtime은 `verification_browser_driver_v2` combined request
하나로 v1의 exact deterministic fields와 세 viewport capture contract를
함께 받는다. Result contract는 `verification_browser_driver_result_v2`이며
v1-compatible browser result와 raw screenshot result를 함께 반환한다. Case
identity, origin, adapter/browser identity와 capture matrix가 다르면 effect
전에 거부한다. 하나의 context에서 두 결과를 만들고 coordinator는 기존
browser normalizer와 versioned screenshot normalizer로 각각 검증해 기존
schema-2 browser와 screenshot evidence를 순서대로 기록한다. V1 runtime
request/result는 fixture/unit compatibility만 유지한다.

### UIR-REQ-004 — Reproducible screenshots

`verification_screenshot_runtime_v2` expectation의 `case_state`는 같은
combined browser attempt가 만든 동일 context의
`after-declared-actions` 상태만 참조한다. Screenshot effect가 별도로
navigate하거나 actions를 재실행해서는 안 된다. Browser assertions가
통과한 뒤 `375x812`, `768x1024`, `1440x900` 순서로 viewport를 설정하고
readiness를 다시 확인해 캡처한다. 이 viewport layout 변경은 browser
rendering 입력이며 bitmap resize가 아니다.

Versioned combined result normalization은 v1-compatible browser result를
먼저 검증하고, snapshot capture matrix와 검증된 `final_url`로
`verification_screenshot_runtime_v2` expectation을 파생한다. 그
`final_url`이 screenshot result와 세 capture의 exact expected URL이다.
Initial URL은 navigation action 뒤 기대값으로 재사용하지 않는다.
`final_url`은 기존 browser normalizer의 exact recorded-origin 검사를 먼저
통과해야 한다.

Combined browser action이 성공으로 완료되기 전에 normalized capture
metadata와 세 PNG를 등록 artifact root에 content-addressed reference로
persist하고 browser evidence가 이를 참조한다. 다음 screenshot action은
strict artifact reader로 media type, path, size, hash와 bytes를 다시
검증한 뒤 기존 screenshot records를 만든다. 이 단계는
`execute_screenshots`나 다른 browser effect를 호출하지 않는다. Process
crash/reopen 뒤에도 같은 references에서 materialize할 수 있어야 하며
누락·변조는 fail-close한다.

캡처는 `type: "png"`, `fullPage: false`, `animations: "disabled"`,
`caret: "hide"`, `omitBackground: false`, `scale: "css"`, DPR `1`을
사용한다. resize/crop/format/color/alpha/post-processing을 하지 않으며
기존 strict result normalizer가 dimensions, bytes, SHA-256과 identity를
검증한다.

### UIR-REQ-005 — Trace, privacy, and cleanup

Trace는 navigation 전에 owner-only temporary path에서 시작하고 exact
requested ZIP path로 종료한다. Assertion outcome은 trace가 아니라 기존
구조화 step evidence가 authority다. Raw DOM, request/response body,
cookies, storage state, trace contents는 record/log에 복제하지 않는다.
Credential-bearing action/config, upload/download, permission request,
storage-state 입력은 effect 전에 거부한다.

정상·실패·timeout·abort 모두 `tracing.stop → context.close →
browser.close` 순서로 bounded cleanup한다. 실패한 temporary artifact,
profile, browser process가 남지 않아야 하며 cleanup 실패는 pass가 아니다.

### UIR-REQ-006 — Production bootstrap wiring

기본 PM gate는 UI가 켜졌다는 이유만으로 `SPEC_DELTA_REQUIRED`를 만들지
않는다. 대신 exact capability discovery 결과를 사용한다.

Default bootstrap은 `execute_browser` combined effect를 runtime attempt당
한 번 호출하고 별도 `execute_screenshots` 경로를 선택하지 않는다. 기존
분리 screenshot 실행 API는 fixture/unit compatibility용으로만 남기며
production runtime에 등록하지 않는다. Combined effect 결과에서 기존
browser action과 screenshot action/evidence를 순서대로 정규화·기록하되
외부 browser effect를 두 번째로 호출하지 않는다.

Browser action 뒤 screenshot action은 이미 persisted된 combined capture
artifact를 materialize하는 coordinator-owned 단계다. Browser action과
screenshot action 사이에서 process가 재시작돼도 runtime을 다시 실행하지
않고 기존 browser evidence reference를 사용한다.

Production bootstrap은 caller가 임의 baseline bytes를 주입하게 하지 않고,
immutable snapshot 생성 후 기존 approved-baseline verifier가 검증한
manifest/object bytes를 case/viewport matrix로 읽는다. Optional semantic
review에는 고정 checklist identity
`ark-ui-semantic-checklist / 1.0.0`을 사용한다. 기존 비교기
`ark-team-comparison / 1.0.0`은 별도 외부 process 없이 capability로
등록한다.

이를 위해 `RunVerificationBootstrapInput`에는 production 전용
`ui_evidence_source: "approved_store"`를 추가한다. Bootstrap의 사전 입력
검사는 이 marker와 UI 활성화의 일치만 확인한다. Snapshot이 persisted된
뒤 coordinator가 `RunStore`의 strict approved-baseline reader를 호출해
검증된 bytes를 읽고, 그 결과만 visual 단계에 전달한다. 기존
`baseline_png_bytes_by_case` injection은 fixture test 호환용으로만 남기고
default PM gate에서는 사용하지 않는다.

Baseline 누락/불일치, required semantic capability 부재, package/browser
불일치, browser launch 실패는 기존 closed outcome으로 종료한다. Backend
lane, legacy records, source/package fingerprints, approval 및 PM gate
규칙은 변경하지 않는다.

### UIR-REQ-007 — Agentic boundary

Browser Use `0.13.7`과 Stagehand `3.7.0`은 조사된 future candidate일 뿐
`IS-1708` dependency가 아니다. Vendor domain policy와 action denylist만으로
exact origin/positive tool allowlist를 증명할 수 없으므로 agentic capability는
`unavailable` optional 상태를 유지한다.

후속 adapter는 telemetry 비활성화, 축소 child environment, exact-origin
egress enforcement, generic-to-vendor action mapping, unknown-tool
fail-close를 별도 승인받아야 한다. Agentic self/judge 결과는 계속 advisory다.

## 6. Traceability와 구현 slice

| Requirement | Parent contract | Acceptance | Test | Slice |
| --- | --- | --- | --- | --- |
| `UIR-REQ-001` | `REQ-1702`, `REQ-1714` | `UIR-AC-001` | `UIR-TEST-001` | `IS-1708` |
| `UIR-REQ-002` | `REQ-1710`, `REQ-1715`, `REQ-1716` | `UIR-AC-002` | `UIR-TEST-002` | `IS-1708` |
| `UIR-REQ-003` | `REQ-1710` | `UIR-AC-003` | `UIR-TEST-003` | `IS-1708` |
| `UIR-REQ-004` | `REQ-1711` | `UIR-AC-004` | `UIR-TEST-004` | `IS-1708` |
| `UIR-REQ-005` | `REQ-1706`, `REQ-1716` | `UIR-AC-005` | `UIR-TEST-005` | `IS-1708` |
| `UIR-REQ-006` | `REQ-1713`, `REQ-1719`, `REQ-1720`, `REQ-1722` | `UIR-AC-006` | `UIR-TEST-006` | `IS-1708` |
| `UIR-REQ-007` | `REQ-1723` | `UIR-AC-007` | `UIR-TEST-007` | `IS-1708` |

`IS-1708`은 하나의 vertical slice다. Playwright package/browser identity,
browser/screenshot execution, approved baseline loading, default PM gate
wiring, focused tests와 전체 회귀를 함께 완료해야 한다. 일부만 구현한
상태를 UI QA 완료로 보고하지 않는다.

## 7. Acceptance criteria

- `UIR-AC-001`: exact package/browser/adapter identity와 승인 `SPEC.md`
  SHA-256만 available이며 mutable CLI, alpha browser, missing install,
  spec hash mismatch는 fail-close한다.
- `UIR-AC-002`: browser가 local exact origin 밖의 HTTP(S)/WebSocket과
  persistent/credential/proxy 경계를 넘지 않는다.
- `UIR-AC-003`: 하나의 combined effect에서 선언된 action/assertion만 고정
  mapping과 timeout으로 실행되고 구조화 evidence가 pass authority다.
- `UIR-AC-004`: 성공한 combined runtime attempt의 browser와 visual
  evidence 전체에서 한 fresh context와 action 실행 1회만 사용해 각
  viewport의 exact PNG가 검증된 browser `final_url`에서 캡처되고 versioned
  normalizer를 통과한다. Screenshot records는 durable combined artifacts로
  materialize되며 reopen이 browser effect를 반복하지 않는다.
- `UIR-AC-005`: trace와 child lifecycle이 성공·실패 모두 닫히고 raw/private
  data가 구조화 record에 복제되지 않는다.
- `UIR-AC-006`: 승인 baseline이 있는 UI-only/both-enabled run은 default
  gate에서 실행되며 기존 non-pass와 Backend 동작을 보존한다.
- `UIR-AC-007`: agentic 제품은 설치·호출되지 않고 optional unavailable과
  advisory-only 경계가 유지된다.

## 8. Verification cases

- `UIR-TEST-001`: exact stable package/browser/spec hash positive와 missing
  package, wrong version/build, 변경된 `SPEC.md` bytes, `@playwright/cli`,
  system Chrome, runtime install negative를 검증한다.
- `UIR-TEST-002`: local HTTP/WS positive와 외부 origin, 다른 port,
  redirect, service worker, proxy env, file/chrome URL, persistent context
  negative를 실제 headless browser로 검증한다.
- `UIR-TEST-003`: combined request identity와 action/assertion 종류별
  positive, strict multi-match, missing selector, response listener timing,
  hash mismatch, timeout, undeclared/evaluate/force negative를 검증한다.
- `UIR-TEST-004`: first-attempt success인 default bootstrap에서 combined
  runtime 호출 1회, declared action/side effect 1회, 세 viewport
  dimensions/DPR/PNG/hash와 viewport order를 확인한다. 별도 screenshot
  effect, 같은 attempt 안의 repeated side effect, bitmap crop/resize/JPEG,
  wrong build, reordered result를 거부한다. Same-origin navigation 뒤
  browser `final_url` positive와 initial/different/cross-origin screenshot
  URL negative를 포함한다. 별도 failure fixture는 기존 browser retry
  ceiling과 immutable input을 검증한다. Browser/screenshot 단계 사이
  reopen positive와 missing/tampered staged artifact negative도 검증하며
  browser effect 호출 수는 그대로 1이어야 한다.
- `UIR-TEST-005`: pass/fail/timeout/abort에서 trace flush, artifact bound,
  context/browser 종료, temporary cleanup, no raw structured copy를 확인한다.
- `UIR-TEST-006`: backend-only, UI-only, both-enabled, missing baseline,
  required/optional semantic review, comparison failure와 PM gate 결과를
  검증한다. Baseline create/update는 시도하지 않는다.
- `UIR-TEST-007`: Browser Use, Playwright agent CLI/MCP, Stagehand이
  dependency/runtime call graph에 없고 agentic absence가 deterministic pass를
  바꾸지 않음을 검증한다.

## 9. 문서 작업 상태

v1.0.2는 실브라우저 구현 검증에서 확인된 잘못된 `dev` hostname을 사용자
정정대로 `devbox`로 보정한다. 또한 redirect 선검사용
`route.fetch/fulfill`이 정상 WebSocket을 막는 Playwright 동작을 확인해,
새로 시작한 exact Chromium target 내부의 request-stage guard로 HTTP(S)
경계를 구현하도록 구체화한다. 제품의 HTTP, bind, port, exact-origin,
resolver boundary는 바꾸지 않는다.

v1.0.1은 구현 검토에서 확인된 `AMBIGUITY`를 보정했다. v1.0.0의
viewport당 action 반복은 제거됐지만 별도 browser/screenshot effect 사이의
중복은 남아 있었다. Combined UI-case effect가 두 기존 evidence contract를
한 context에서 생성하도록 결정했으며 다른 제품 동작은 바꾸지 않는다.

v1.0.2 host 보정 evidence에는 `0.0.0.0:10091` local fixture와 exact
Chromium 접속을 사용했다. Baseline 생성·변경, model/agentic 실행, Docker,
인프라 또는 시스템 설정 변경은 하지 않았다. 나머지 `UIR-TEST-001`부터
`UIR-TEST-007`까지는 `IS-1708` implementation loop에서 실행한다.
