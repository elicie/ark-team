# Implementation Handoff — SLICE-017 UI Runtime

- Package: `ark-team-verification-ui-runtime-v1.0.0`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Parent: `verification-spec-v4`
- Exact next slice: `IS-1708`
- Normative contract: [SPEC.md](./SPEC.md)
- Normative SPEC SHA-256:
  `9a67ffa8a80ed73088691670e27e47033fe1a1eb83d108933553b7ce4e4734f3`
- Source baseline:
  `9e6f16b2024bf65ce897479180415340a944cf31`

## 구현 결과

`IS-1708`은 기존 coordinator에 하나의 production Playwright runtime을
연결한다. 새 QA framework, agent workflow 또는 범용 browser platform을
만들지 않는다.

예상 변경 surface는 다음으로 제한한다.

- `package.json`, `package-lock.json`
  - exact `@playwright/test@1.62.0`
- `verification-local-runtime.ts`
  - UI preflight, capability, lifecycle, default bootstrap input
- `verification-coordinator.ts`
  - `ui_evidence_source` marker와 snapshot 이후 baseline loading
- 새 runtime 파일 한 개
  - Playwright browser/screenshot effect
- `verification-visual-adapter.ts`
  - screenshot request에 readiness/actions 전달
- approved baseline store
  - 검증된 object bytes의 read-only production loading API
- 관련 focused tests와 build output

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
- system Chrome 또는 CDP attach

## 구현 순서

1. exact dependency와 browser identity preflight
2. local exact-origin browser driver
3. screenshot request state 정보와 action 1회/세 viewport capture
4. `ui_evidence_source`와 approved baseline bytes의 snapshot 이후 resolver
5. default PM gate UI wiring과 comparison capability
6. focused real-browser tests, 전체 회귀, build/CodeGraph

Implementation setup에서 exact dependency를 lock한 뒤
`npx --no-install playwright install chromium`으로 해당 revision만
provision할 수 있다. QA runtime 자체는 install을 호출하지 않으며
`--with-deps`로 system package를 변경하지 않는다.

## 필수 안전 조건

- `headless: true`
- custom executable/channel/persistent profile 없음
- 유일한 launch arg:
  `--host-resolver-rules=MAP dev 127.0.0.1`
- `serviceWorkers: "block"`
- HTTP(S)/WebSocket exact-origin firewall
- proxy/credential environment 제거
- credential/storage-state/upload/download/permission 없음
- literal local server argv와 기존 port `10001+` 규칙 유지
- `tracing.stop → context.close → browser.close`
- baseline create/update 없음

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
`http://dev:<port>`를 사용한다. Docker를 사용하지 않는다.

다음 positive/negative evidence가 모두 있어야 한다.

- stable Playwright/Chromium exact match
- external HTTP와 WebSocket effect 전 차단
- action/assertion/trace positive
- action 1회 후 세 viewport screenshot과 comparison positive
- missing package/browser/baseline/required semantic fail-close
- Backend-only 전체 회귀
- browser/context/server process 잔존 없음

## 구현 금지

- Browser Use/Stagehand/agent CLI 설치 또는 호출
- baseline 생성 도구
- remote browser/model
- test generation/healing
- schema-3 또는 새 coordinator
- UI mode, dashboard, generic plugin system
- 기존 v4 package fingerprint 변경

## 중단 조건

다음이 발견되면 추론해 구현하지 말고 `SPEC_DELTA_REQUIRED`로 반환한다.

- Playwright v1.62.0에서 exact network/WS 차단이 불가능함
- screenshot request의 readiness/action bytes가 기존 immutable case와
  일치할 수 없음
- production baseline bytes를 strict verifier 경계 안에서 읽을 수 없음
- trace 또는 process cleanup이 기존 artifact/lifecycle 계약과 충돌함
- Next.js `allowedDevOrigins`를 source에서 증명할 수 없음
