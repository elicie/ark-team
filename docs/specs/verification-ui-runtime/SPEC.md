# SLICE-017 결정론적 UI 런타임 보완 명세

- Spec identity: `ark-team-verification-ui-runtime-v1.0.0`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Authority date: 2026-07-27 UTC
- Authority: 사용자가 요청한 실제 UI QA 실행 기능, Backend/UI 독립 실행
  요구, `verification-spec-v4`, 그리고 이 보완안으로 진행하라는 사용자 승인
- Target source:
  `GIT-COMMIT:9e6f16b2024bf65ce897479180415340a944cf31`
- Target tree: `e5c9f071d68ab5e2e46e28cf8f0c33ccca2187b3`
- Parent contract: `docs/slices/SLICE-017.md`
  (`verification-spec-v4`)
- Reference boundary: `NONE`
- Deliverable: 이 문서 package만 작성하며 제품 코드나 의존성을 변경하지 않는다.

## 1. 목적과 완료 신호

현재 기본 검증 게이트는 Backend `curl` QA만 실사용 경로에 연결하고, UI가
활성화되면 정확한 실행 계약이 없다는 이유로 `SPEC_DELTA_REQUIRED`를
기록한다. 이 문서는 기존 schema-2 browser/screenshot/comparison 계약을
바꾸지 않고 생산용 Playwright 실행기를 연결하는 다음 구현 슬라이스
`IS-1708`을 닫는다.

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
| `UIR-EVID-003` | screenshot request는 `case_state = "after-declared-actions"`를 요구하지만 readiness/action bytes를 전달하지 않는다. | 생산 실행기가 상태를 추론하지 않도록 request를 보완해야 한다. |
| `UIR-EVID-004` | 기본 bootstrap 입력은 UI baseline PNG와 semantic checklist를 외부 호출자가 넣어야 한다. | 기본 PM 게이트가 승인 baseline store에서 읽는 production resolver가 필요하다. |
| `UIR-EVID-005` | 저장소 `package.json`과 lockfile에 Playwright 의존성이 없다. | 실행 중 자동 설치하지 말고 구현 commit에서 exact dependency를 추가한다. |
| `UIR-EVID-006` | Codex Playwright wrapper SHA-256은 `aa3fdff5d0e4556177f4dfd5f04117e772aa54f94b6a2e34b6c0edf629c6b9b5`이며 `npx --yes --package @playwright/cli`를 사용한다. | 버전이 고정되지 않은 agent CLI wrapper는 gate 실행기가 아니다. |
| `UIR-EVID-007` | 관측된 `@playwright/cli 0.1.17`은 alpha Playwright와 Chromium `151.0.7922.10`을 사용한다. | 안정판 browser identity와 일치하지 않는다. |
| `UIR-EVID-008` | 현재 host에서 `dev` lookup은 `EAI_AGAIN`이다. | 시스템 DNS나 `/etc/hosts`를 변경하지 않고 Chromium 안에서 exact `dev → 127.0.0.1` mapping을 사용한다. |

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
- `UIR-DEC-004`: 한 browser/screenshot 요청마다 local headless browser를
  시작하고 `finally`에서 닫는다. daemon, persistent session, CDP attach,
  system Chrome을 재사용하지 않는다.
- `UIR-DEC-005`: 결정론적 browser case는 `1440x900`에서 한 번 실행한다.
  visual capture도 하나의 fresh context에서 navigation/readiness/action을
  한 번만 실행하고 viewport layout만 고정 순서로 바꿔 캡처한다. 따라서
  click이나 submit의 server side effect를 세 번 반복하지 않는다.
- `UIR-DEC-006`: system resolver를 바꾸지 않고 유일한 Chromium launch
  argument `--host-resolver-rules=MAP dev 127.0.0.1`을 사용한다. URL gate는
  여전히 exact `http://dev:<recorded-port>` origin을 검사한다.
- `UIR-DEC-007`: semantic review가 optional이면 unavailable 결과를
  보존하고 비교를 계속한다. required이면 기존 capability gate가
  `unavailable`로 닫는다.
- `UIR-DEC-008`: 승인 baseline은 읽기 전용으로 검증·로딩한다. 이번
  slice는 baseline bytes를 만들거나 바꾸지 않는다.

### 알려진 경고

- Playwright trace는 DOM/network 내용을 포함할 수 있고 공식 redaction
  옵션이 없다. 이번 범위는 credential 없는 로컬 fixture만 허용하고 trace를
  owner-only artifact로 보존하며 raw 내용을 구조화 record/log로 복제하지
  않는다.
- pixel 결과는 OS/font/rendering 환경에도 영향을 받는다. 기존 v4 baseline
  tuple과 strict byte comparison을 유지하며 mismatch를 자동 승인하거나
  baseline으로 승격하지 않는다.
- Next.js 프로젝트는 기존 요구대로 `allowedDevOrigins`에 `dev`가 있음을
  별도 source inspection으로 증명해야 한다.

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

페이지 생성 전 HTTP(S) route와 WebSocket route를 등록한다. exact recorded
origin만 통과하고 다른 host/scheme/port, cross-origin redirect, `file:`,
`chrome:`, external WebSocket은 effect 전에 차단한다. 초기 `about:blank`과
allowed-origin에서 생성된 non-network `data:`/`blob:`만 허용한다.

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

### UIR-REQ-004 — Reproducible screenshots

`VerificationScreenshotRuntimeRequest`는 snapshotted case의 exact
readiness와 ordered actions를 포함하도록 versioned 보완한다. 실행기는
하나의 fresh context를 `1440x900`으로 열고 navigation/readiness/actions를
한 번 실행한다. 그 뒤 `375x812`, `768x1024`, `1440x900` 순서로 browser
viewport를 설정하고 readiness를 다시 확인한 뒤 캡처한다. 이 viewport
layout 변경은 browser rendering 입력이며 bitmap resize가 아니다.

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
- `UIR-AC-003`: 선언된 action/assertion만 고정 mapping과 timeout으로
  실행되고 구조화 evidence가 pass authority다.
- `UIR-AC-004`: 한 fresh context에서 action을 한 번만 실행한 상태로 각
  viewport의 exact PNG가 캡처되고 기존 normalizer를 통과한다.
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
- `UIR-TEST-003`: action/assertion 종류별 positive, strict multi-match,
  missing selector, response listener timing, hash mismatch, timeout,
  undeclared/evaluate/force negative를 검증한다.
- `UIR-TEST-004`: 세 viewport dimensions/DPR/PNG/hash, action 1회 실행,
  viewport order를 확인하고 repeated side effect, bitmap
  crop/resize/JPEG, wrong build, reordered result를 거부한다.
- `UIR-TEST-005`: pass/fail/timeout/abort에서 trace flush, artifact bound,
  context/browser 종료, temporary cleanup, no raw structured copy를 확인한다.
- `UIR-TEST-006`: backend-only, UI-only, both-enabled, missing baseline,
  required/optional semantic review, comparison failure와 PM gate 결과를
  검증한다. Baseline create/update는 시도하지 않는다.
- `UIR-TEST-007`: Browser Use, Playwright agent CLI/MCP, Stagehand이
  dependency/runtime call graph에 없고 agentic absence가 deterministic pass를
  바꾸지 않음을 검증한다.

## 9. 문서 작업 상태

이 package 작성 중 제품 의존성 설치, browser 다운로드, server 실행,
browser QA, model/agentic 실행, baseline 생성, Docker, 인프라 변경은 하지
않았다. 실제 `UIR-TEST-001`부터 `UIR-TEST-007`까지는 `IS-1708`
implementation loop에서 실행한다.
