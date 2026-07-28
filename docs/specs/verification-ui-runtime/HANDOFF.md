# Implementation Handoff — SLICE-017 UI Runtime

- Package: `ark-team-verification-ui-runtime-v1.1.0`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Delta status: `SPEC_DELTA_APPLIED`
- Supersedes: `ark-team-verification-ui-runtime-v1.0.3`
- Parent: `verification-spec-v4`
- Reference boundary: `NONE`
- Evidence coverage: committed config/snapshot/artifact/bootstrap source와
  test fixture inspection
- Exact next slice: `IS-1709`
- Normative contract: [SPEC.md](./SPEC.md)
- Normative SPEC SHA-256:
  `d04abb88e86f9f6feb7c912eacbb9abba2a720ad5361cffe8836430c26afefde`
- Source baseline:
  `ee08739dc7a985933955db5e2d830b62ca4a6efb`

## 구현 계약

`IS-1708`의 production Playwright, RGB8/RGBA8 comparison과 strict
approved-store reader는 유지한다. 이번 delta는 tracked project config의
source-hash 자기참조를 제거하고, stable selector를 clean source capture
뒤 exact full identity로 해석한다. 새 baseline generator, QA framework,
agent workflow 또는 범용 registry를 만들지 않는다.

예상 변경 surface는 다음으로 제한한다.

- `verification-contract.ts`
  - strict `baseline_selector = { id, environment }` project config
  - 기존 full-identity resolved config/snapshot 호환
- `verification-artifact-store.ts`
  - Git-ignored/non-tracked root와 bounded candidate manifest discovery
  - exactly-one matching candidate의 기존 strict object verification
- `state-store.ts`
  - clean source capture 뒤, snapshot persistence 전 selector resolution
- `project-config`, contract/artifact/store/bootstrap focused tests
- approved SPEC copy/hash, plugin cachebuster와 build output

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

1. selector/full-identity config compatibility와 strict parser
2. bounded read-only manifest discovery 및 exactly-one match
3. pre-snapshot resolution과 full identity persistence/reopen
4. focused real-Git negatives, 전체 회귀, build/CodeGraph

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
- baseline root는 Git-ignored이고 tracked file이 0개
- candidate entry 최대 `500`, manifest 최대 `65536` bytes
- latest/mtime/fallback 선택 없음
- 원본 PNG bytes/hash 보존, RGB 외 alpha 확장/색 공간 변환 없음

## Production bootstrap 입력

UI baseline bytes를 PM gate 호출자가 임의로 전달하지 않는다. Tracked
config는 `baseline_root`와 `baseline_selector.id/environment`만 선언한다.
Clean source capture 뒤 snapshot 생성 전에 resolver가
`manifests/<selector-id>`의 read-only canonical manifest를 bounded하게
검사한다.

```text
browser case × 375x812
browser case × 768x1024
browser case × 1440x900
```

현재 source commit/tree, selector environment, exact adapter/version/
browser build와 위 matrix가 일치하는 manifest가 정확히 하나여야 한다.
Resolver는 그 canonical set hash와 full identity를 기존 resolved
config/snapshot에 고정한다. 각 object는 기존 manifest
path/hash/dimension/permission 검증을 통과해야 한다. Semantic review
checklist identity는
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
- selector config를 commit한 real Git fixture의 clean source positive
- missing/multiple/wrong-source/wrong-environment manifest fail-close
- malformed/writable/symlink/oversize/non-ignored/tracked baseline negative
- snapshot 전에 baseline write, server/browser effect 0회
- 기존 inline full-identity fixture와 persisted snapshot reopen
- Backend-only 전체 회귀
- browser/context process 잔존 없음

## 구현 금지

- Browser Use/Stagehand/agent CLI 설치 또는 호출
- baseline 생성 도구
- baseline 자동 승인·갱신·승격
- latest/mtime/임의 첫 manifest 선택
- project 또는 selector directory 밖 탐색
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

- selector를 full identity로 해석하기 전에 source/config snapshot이
  persist돼야 하는 기존 계약과 충돌함
- 기존 full-identity snapshot을 byte-equivalent하게 reopen할 수 없음
- Git-ignored/non-tracked root를 literal Git argv로 증명할 수 없음
- candidate discovery가 symlink/path/permission 경계를 유지할 수 없음
- exactly-one selection이 기존 manifest content identity와 충돌함
