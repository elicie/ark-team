# Package Status — SLICE-017 UI Runtime

- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Delta status: `SPEC_DELTA_APPLIED`
- Identity: `ark-team-verification-ui-runtime-v1.0.2`
- Supersedes: `ark-team-verification-ui-runtime-v1.0.1`
- Authority date: 2026-07-28 UTC
- Package root: `docs/specs/verification-ui-runtime`
- Parent contract: `verification-spec-v4`
- Approved implementation slice: `IS-1708`
- Exact next action: `sdd-implementation-loop`로 `IS-1708` 하나만 구현
- Normative SPEC SHA-256:
  `29f69eda06ba8bf47d32e0e3914686f147ef0e5e7c01d3d18f4cd3b4549f4047`

## Source

- Commit:
  `fcebe022dd00add51ece1e98e40be81f78f8a28b`
- Tree:
  `62445c044022e23f0389f826b5c6e460edc9ae65`
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

## 경고

- 현재 저장소에는 Playwright dependency/browser가 없다.
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

## 이번 문서 작업에서 실행하지 않음

- 제품 구현과 테스트
- dependency/browser 설치
- server/browser/model 실행
- baseline 생성·갱신
- Docker 또는 인프라 변경
