# Package Status

- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Identity: `ark-team-provider-adapters-v1.1.0`
- Authority date: 2026-07-27 UTC
- Package root: `docs/specs/app-server-provider-adapters`
- Approved slices: `SLICE-001`, `SLICE-002`, `SLICE-003`, `SLICE-004`
- Blocked slices:
  - `SLICE-005`: Z.AI Coding Plan live activation; provider policy/authorization
    evidence required
  - `SLICE-006`: Claude account OAuth; credential lifecycle spec delta required
- Open non-blocking questions:
  - `Q-001`: Claude account OAuth를 후속 승인할지
  - `Q-002`: worker 이후 PL/integration PL/PM으로 확장할지
  - `Q-003`: Z.AI가 Ark Team/Codex bridge를 지원 도구로 허용할지
- Supersedes:
  - `ark-team-provider-adapters-v1.0.0`
  - 대화 중 작성된 비공식 provider 계획
- Generated from:
  - 사용자 요구사항
  - Ark-owned catalog에 API key 값을 직접 저장하라는 사용자 명시 지시
  - Ark Team source baseline
    `50531832a57e3fd0dae093b7ad0b51197e668045`
  - OpenCodex `v2.7.41`
    `ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`
  - Codex CLI/app-server `0.145.0` generated schema
  - current Z.AI Open Platform Quick Start와 Chat Completion API
  - current Z.AI supported-tool and subscription policy pages
- Evidence coverage:
  - Ark config, app-server client/session, worker scheduler, persisted assignment,
    tests and scripts: explored
  - OpenCodex base/OpenAI Chat/Anthropic adapters and registry: explored
  - OpenCodex Google/Responses adapters: partial, bounded to approved later slices
  - inline credential schema, redaction, permission, rotation contract: specified
  - live inline credential: not used
  - live paid providers and OAuth lifecycle: not executed
- Source identities:
  - Ark Team Git commit:
    `50531832a57e3fd0dae093b7ad0b51197e668045`
  - Ark Team tree:
    `de77e16a2c257456721bd44fc260f6b90afd2af6`
  - Delta application Git HEAD:
    `150d81a4ebe97ce0aeb2046f8f1461a73fa91742`
  - Delta application worktree:
    user-authorized `~/.ark-team/runs` default change와 이 spec delta가 존재함
  - OpenCodex Git commit:
    `ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`
- Warnings:
  - Custom adapters are trusted executable code, not sandboxed extensions.
  - OpenCodex-derived code must preserve pinned provenance and MIT notice.
  - Z.AI Coding Plan live use remains blocked until policy authority changes.
  - Inline API key는 plaintext이므로 owner-only permission이 필요하고,
    version control, backup, 동기화 대상에서도 별도로 제외해야 한다.
- Next action: implement only `SLICE-001` through `sdd-implementation-loop`.
