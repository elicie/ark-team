# Package Status — SLICE-017 UI Runtime

- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Delta status: `SPEC_DELTA_APPLIED`
- Identity: `ark-team-verification-ui-runtime-v1.0.3`
- Supersedes: `ark-team-verification-ui-runtime-v1.0.2`
- Authority date: 2026-07-28 UTC
- Package root: `docs/specs/verification-ui-runtime`
- Parent contract: `verification-spec-v4`
- Approved implementation slice: `IS-1708`
- Exact next action: `sdd-implementation-loop`로 `IS-1708` 하나만 구현
- Normative SPEC SHA-256:
  `571b5cae52473b6dc5b0e8416406f881062b2a8c8729c401aaa06667efe6e383`

## Source

- Commit:
  `0e3dd1609406406b948a96894ed57f0d7181c76e`
- Tree:
  `a0e533f0a2ef4136e8f913750a82723f876c9043`
- Worktree state at capture: clean

## 확정

- deterministic gate는 stable repo-local Playwright library를 사용한다.
- exact identity:
  `playwright-cli / ark-ui-1.0.0-pw-1.62.0`
- exact browser:
  `chromium-headless-shell-151.0.7922.34-r1234`
- exact local hostname/origin:
  `devbox / http://devbox:<recorded-port>`
- initial navigation 전 exact Chromium target의 request-stage guard가
  redirect를 포함한 HTTP(S) effect를 차단한다.
- runtime capability는 위 승인 `SPEC.md` SHA-256도 검증한다.
- 기존 Backend runtime, contract-v2/schema-2, package-v4를 유지한다.
- default gate는 combined UI-case effect 한 번으로 browser와 screenshot
  evidence를 만들며 declared actions를 runtime attempt당 한 번 실행한다.
- combined capture는 durable artifact로 전달해 reopen이 browser effect를
  반복하지 않는다.
- production baseline input만 필요한 만큼 보완한다.
- agentic browser는 optional unavailable/advisory 상태를 유지한다.
- 실제 Chromium RGB8와 strict RGBA8 PNG를 원본 hash 보존 후 동일한
  RGBA 픽셀 의미로 비교한다.

## 경고

- 승인 baseline이 없으면 UI visual gate는 pass할 수 없다.
- required semantic review는 local-image adapter가 등록되기 전까지
  unavailable이다.
- trace는 local page content를 포함할 수 있으므로 credential 없는 fixture와
  owner-only artifact 경계를 지켜야 한다.
- visual comparison은 기존 baseline environment 계약보다 넓은 OS/font
  동일성을 자동 증명하지 않는다.
- combined effect는 attempt당 action 1회를 보장하지만 기존 browser retry
  ceiling 때문에 실패 뒤 재시도까지 exactly-once mutation을 보장하지 않는다.

## 조사만 완료된 후속 후보

- Browser Use `0.13.7`
- Stagehand `3.7.0`

두 후보는 exact-origin egress와 positive action mapping의 별도 승인 전에는
설치하거나 실행하지 않는다.

## v1.0.3 delta 근거

- exact Chromium `151.0.7922.34`의 세 viewport capture가 bit depth `8`,
  color type `2`, interlace `0`임을 test-only local fixture에서 확인했다.
- 기존 RGBA8-only 비교가 같은 PNG를 `BASELINE_NOT_APPROVED`로 거부함을
  확인했다.

## v1.0.3 delta에서 제외

- dependency/browser 추가 설치
- baseline 생성·갱신
- model/agentic 실행
- Docker 또는 인프라 변경
