# Package Status — SLICE-017 UI Runtime

- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Identity: `ark-team-verification-ui-runtime-v1.0.0`
- Authority date: 2026-07-27 UTC
- Package root: `docs/specs/verification-ui-runtime`
- Parent contract: `verification-spec-v4`
- Approved implementation slice: `IS-1708`
- Exact next action: `sdd-implementation-loop`로 `IS-1708` 하나만 구현
- Normative SPEC SHA-256:
  `9a67ffa8a80ed73088691670e27e47033fe1a1eb83d108933553b7ce4e4734f3`

## Source

- Commit:
  `9e6f16b2024bf65ce897479180415340a944cf31`
- Tree:
  `e5c9f071d68ab5e2e46e28cf8f0c33ccca2187b3`
- Worktree state at capture: clean

## 확정

- deterministic gate는 stable repo-local Playwright library를 사용한다.
- exact identity:
  `playwright-cli / ark-ui-1.0.0-pw-1.62.0`
- exact browser:
  `chromium-headless-shell-151.0.7922.34-r1234`
- runtime capability는 위 승인 `SPEC.md` SHA-256도 검증한다.
- 기존 Backend runtime, contract-v2/schema-2, package-v4를 유지한다.
- screenshot request와 production baseline input만 필요한 만큼 보완한다.
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
