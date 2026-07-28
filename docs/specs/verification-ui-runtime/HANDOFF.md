# Implementation Handoff — SLICE-017 UI Runtime

- Package: `ark-team-verification-ui-runtime-v1.0.3`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Delta status: `SPEC_DELTA_APPLIED`
- Supersedes: `ark-team-verification-ui-runtime-v1.0.2`
- Parent: `verification-spec-v4`
- Reference boundary: `NONE`
- Evidence coverage: committed source inspection과 exact Chromium runtime
  observation
- Exact next slice: `IS-1708`
- Normative contract: [SPEC.md](./SPEC.md)
- Normative SPEC SHA-256:
  `571b5cae52473b6dc5b0e8416406f881062b2a8c8729c401aaa06667efe6e383`
- Source baseline:
  `0e3dd1609406406b948a96894ed57f0d7181c76e`

## 구현 결과

`IS-1708`의 기존 production Playwright 연결은 유지한다. 이번 delta는
실제 Chromium RGB8 PNG를 strict visual comparison에 연결하고 실제
Backend/UI gate acceptance를 추가한다. 새 QA framework, agent workflow
또는 범용 browser platform을 만들지 않는다.

예상 변경 surface는 다음으로 제한한다.

- `package.json`, `package-lock.json`
  - exact `@playwright/test@1.62.0`
- `verification-local-runtime.ts`
  - UI preflight, capability, lifecycle, default bootstrap input
- `verification-coordinator.ts`
  - combined `execute_browser` 단일 effect, durable capture materialization,
    기존 evidence 기록,
    `ui_evidence_source` marker와 snapshot 이후 baseline loading
- `verification-browser-adapter.ts`
  - `verification_browser_driver_v2` /
    `verification_browser_driver_result_v2` combined contract
- 새 runtime 파일 한 개
  - 단일 Playwright browser/assertion/screenshot effect
- `verification-visual-adapter.ts`
  - `verification_screenshot_runtime_v2` expectation, 동일-context state와
    검증된 browser `final_url` 기준 screenshot 검증
- `verification-png.ts`
  - 비인터레이스 8-bit RGB/RGBA strict decode와 RGB alpha `255` 확장
- approved baseline store
  - 검증된 baseline/capture object bytes의 read-only production loading API
- `verification-local-runtime.ts`
  - loopback readiness 연결에서 exact `devbox:<port>` Host 보존
- test-only `qa-smoke` fixture와 관련 focused tests/build output

파일 배치는 기존 repository convention에 맞춰 조정할 수 있지만
`SPEC.md`의 boundary는 바꾸지 않는다.

## 고정 identity

```text
adapter.name    = playwright-cli
adapter.version = ark-ui-1.0.0-pw-1.62.0
browser_build   = chromium-headless-shell-151.0.7922.34-r1234
```

`playwright-cli`는 기존 schema token이다. 다음은 사용하지 않는다.

- `@playwright/cli`
- Codex Playwright wrapper
- MCP
- `npx --package`
- system Chrome 또는 외부/persistent CDP attach

## 구현 순서

1. strict RGB8/RGBA8 decode와 기존 RGBA 회귀
2. local readiness의 exact `devbox` Host 보존
3. test-only 승인 baseline으로 실제 both-lane 성공/required UI 실패 검증
4. focused real-browser tests, 전체 회귀, build/CodeGraph

## 필수 안전 조건

- `headless: true`
- custom executable/channel/persistent profile 없음
- 유일한 launch arg:
  `--host-resolver-rules=MAP devbox 127.0.0.1`
- `serviceWorkers: "block"`
- HTTP(S)/WebSocket exact-origin firewall
- initial navigation 전 exact Chromium target의 request-stage HTTP(S) guard
- proxy/credential environment 제거
- credential/storage-state/upload/download/permission 없음
- literal local server argv와 기존 port `10001+` 규칙 유지
- `tracing.stop → context.close → browser.close`
- baseline create/update 없음
- 원본 PNG bytes/hash 보존, RGB 외 alpha 확장/색 공간 변환 없음

## Production bootstrap 입력

UI baseline bytes를 PM gate 호출자가 임의로 전달하지 않는다. Snapshot
생성 후 기존 strict manifest/object verifier가 다음 matrix를 읽는다.

```text
browser case × 375x812
browser case × 768x1024
browser case × 1440x900
```

각 object는 기존 manifest path/hash/dimension/permission 검증을 통과해야
한다. Semantic review checklist identity는
`ark-ui-semantic-checklist / 1.0.0`으로 고정한다.

Production input은 `ui_evidence_source: "approved_store"` marker를 사용한다.
기존 `baseline_png_bytes_by_case`는 fixture test용 호환 입력으로만
유지하며 default PM gate가 선택하지 않는다.

## 완료 검증

최소 명령:

```bash
npm run typecheck
npm run test:unit
npm run test:verification-runtime
npm run build
npm test
```

추가 real-browser fixture는 port `10001` 이상, bind `0.0.0.0`, URL
`http://devbox:<port>`를 사용한다. Docker를 사용하지 않는다.

다음 positive/negative evidence가 모두 있어야 한다.

- stable Playwright/Chromium exact match
- external HTTP와 WebSocket effect 전 차단
- action/assertion/trace positive
- first-attempt success에서 combined runtime 호출과 declared action/side
  effect 각 1회
- 같은 context의 세 viewport screenshot과 comparison positive
- 실제 Chromium RGB8 및 strict RGBA8 comparison positive
- unsupported PNG 형식 fail-close
- same-origin action navigation 뒤 browser `final_url`과 screenshot URL 일치
- browser/screenshot 단계 사이 reopen 시 runtime 재호출 없는 materialization
- missing package/browser/baseline/required semantic fail-close
- Backend-only 전체 회귀
- browser/context process 잔존 없음

## 구현 금지

- Browser Use/Stagehand/agent CLI 설치 또는 호출
- baseline 생성 도구
- RGB/RGBA 외 PNG 형식의 암묵적 변환
- remote browser/model
- test generation/healing
- schema-3 또는 새 coordinator
- default bootstrap의 별도 browser/screenshot effect 호출
- 기존 browser retry ceiling을 exactly-once mutation 보장으로 해석
- combined capture를 process memory로만 전달
- UI mode, dashboard, generic plugin system
- 기존 v4 package fingerprint 변경

## 중단 조건

다음이 발견되면 추론해 구현하지 말고 `SPEC_DELTA_REQUIRED`로 반환한다.

- Playwright v1.62.0에서 exact network/WS 차단이 불가능함
- combined browser/screenshot request identity가 기존 immutable case와
  일치할 수 없음
- production baseline bytes를 strict verifier 경계 안에서 읽을 수 없음
- trace 또는 process cleanup이 기존 artifact/lifecycle 계약과 충돌함
- Next.js `allowedDevOrigins`의 `devbox`를 source에서 증명할 수 없음
