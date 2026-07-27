# Implementation Handoff — App-Server Provider Adapters

- Package: `ark-team-provider-adapters-v1.1.0`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Reference boundary: `NONE`
- Approved slices: `SLICE-001`, `SLICE-002`, `SLICE-003`, `SLICE-004`
- Exact next slice: `SLICE-001`
- Normative contract: [SPEC.md](./SPEC.md)
- Supersedes: `ark-team-provider-adapters-v1.0.0`

## 1. 구현 순서

1. `SLICE-001`: generic OpenAI-compatible fake upstream을 사용한 external
   worker end-to-end
2. `SLICE-002`: Anthropic API-key builtin
3. `SLICE-003`: Google와 Responses-compatible builtins
4. `SLICE-004`: hash-pinned custom adapter V1

`SLICE-005` Z.AI Coding Plan live activation과 `SLICE-006` Claude account
OAuth는 구현하지 않는다. 각각 provider policy와 credential lifecycle spec
delta가 필요하다.

## 2. 고정 source

### Ark Team baseline

- Commit: `50531832a57e3fd0dae093b7ad0b51197e668045`
- Tree: `de77e16a2c257456721bd44fc260f6b90afd2af6`
- Capture: clean before this spec package was added
- Delta application observation:
  - Git HEAD:
    `150d81a4ebe97ce0aeb2046f8f1461a73fa91742`
  - worktree에는 사용자가 승인한 기본 state root 변경과 이 spec delta가
    존재한다.
  - 구현자는 실제 worktree baseline을 다시 기록하고 해당 변경을 되돌리지
    않는다.

### OpenCodex reference

- Repository: `lidge-jun/opencodex`
- Tag: `v2.7.41`
- Commit: `ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`
- License observed: MIT
- Permitted reference inputs:
  - `src/adapters/base.ts`
  - `src/adapters/openai-chat.ts`
  - `src/adapters/anthropic.ts`
  - `src/adapters/google.ts`
  - `src/adapters/openai-responses.ts`
  - directly required shared types/helpers
- Prohibited import scope:
  - CLI/GUI
  - management API
  - config mutation
  - history/resume synchronization
  - provider registry 전체
  - OAuth account/token store

다른 OpenCodex revision이나 `main`을 사용하지 않는다. package dependency의
internal path를 직접 import하지 말고 필요한 code를 Ark-owned contract로
port한다.

## 3. SLICE-001 target

### 필수 결과

외부 worker override가 존재할 때:

```text
Run model binding
  → ProviderCatalog
  → builtin:openai-chat
  → authenticated loopback ProviderBridge
  → Codex app-server custom Responses provider
  → thread/start + turn/start
  → fake OpenAI Chat upstream
  → strict worker_report
```

override가 없으면 현재 Luna worker의 request, sandbox, approvals, retries,
output validation이 그대로 유지돼야 한다.

### 주요 변경 예상 위치

- `plugins/ark-team/runtime/src/provider-config.ts`
  - `ARK_TEAM_PROVIDER_CONFIG`
  - strict TOML/Zod schema
  - mutually exclusive `inline_key`, `env_key`, `none`
  - owner-only inline-key catalog permission 검사
  - redacted canonical hash
- `plugins/ark-team/runtime/src/provider-types.ts`
  - model binding, capabilities, normalized request/event, errors
- `plugins/ark-team/runtime/src/provider-registry.ts`
  - builtin/custom adapter resolution
- `plugins/ark-team/runtime/src/provider-bridge.ts`
  - authenticated `127.0.0.1`, port >=10001
  - Responses route와 upstream dispatch
  - request-time inline/environment credential resolution
- `plugins/ark-team/runtime/src/adapters/openai-chat.ts`
  - pinned OpenCodex-derived minimal adapter
  - `text.format` 보완
- `plugins/ark-team/runtime/src/app-server-client.ts`
  - safe argv model provider injection
  - child-only bridge token environment
  - `~/.ark-team/runs/<run-id>` 아래 external isolated `CODEX_HOME`
- `plugins/ark-team/runtime/src/approval-session.ts`
  - binding input
  - `modelProvider` start/resume와 response validation
- `plugins/ark-team/runtime/src/assignment-scheduler.ts`
  - persisted binding 전달
- `plugins/ark-team/runtime/src/domain.ts`
  - run/assignment model-binding schema와 old native compatibility
- `plugins/ark-team/runtime/src/state-store.ts`
  - binding snapshot/event/reopen/resume
- orchestrator/MCP execute input definition
  - optional explicit `model_overrides.worker`

파일명은 repository convention에 맞춰 조정할 수 있지만 normative component
boundary와 behavior는 바꾸지 않는다.

## 4. 승인 requirement closure

SLICE-001:

- Requirements: `REQ-001`, `REQ-003`–`REQ-007`, `REQ-009`–`REQ-012`,
  `REQ-013`, `REQ-015`, `REQ-008`의 `builtin:openai-chat` 부분
- Acceptance: `AC-001`, `AC-003`–`AC-007`, `AC-009`–`AC-013`, `AC-015`
- Tests: `TEST-001`, `TEST-003`–`TEST-007`, `TEST-009`–`TEST-012`,
  `TEST-013`, `TEST-015`

하나라도 닫히지 않으면 slice를 완료로 보고하지 않는다.

## 5. Baseline expectations

- Current default models:
  - PM `gpt-5.6-sol / xhigh`
  - PL `gpt-5.6-terra / xhigh`
  - worker `gpt-5.6-luna / xhigh`
- PM remains on `@openai/codex-sdk`.
- PL/worker assignments use `AppServerApprovalSession`.
- app-server transport remains stdio JSONL.
- current app-server client uses `--strict-config` and disables native
  multi-agent/apps.
- current project config rejects unknown/secret-bearing fields.
- current worker structured reports are validated after the turn.
- current external provider retry budget is three and Luna fallback is false.
- managed runtime의 기본 state root는 `~/.ark-team/runs`이다.

## 6. Verified commands

Repository에서 존재를 확인한 command:

```bash
npm run typecheck
npm run test:unit
npm run build
npm run verify:app-server-schema
npm test
```

`npm run verify:app-server-schema`는 baseline에서 Codex CLI `0.145.0`과
호환됨을 확인했다. 구현 시 generated schema token 목록에 다음을 추가한다.

```text
ThreadStartParams.modelProvider
ThreadStartResponse.modelProvider
ThreadResumeParams.modelProvider
ThreadResumeResponse.modelProvider
```

Default test는 real provider나 paid subscription을 호출하면 안 된다.

## 7. Security constraints

- Docker를 실행하지 않는다.
- Bridge는 보안 요구사항 때문에 `127.0.0.1`에만 bind한다.
- Bridge port는 10001 이상이며 3000을 사용하지 않는다.
- app-server provider config는 safe argv로 전달하고 shell command를 만들지
  않는다.
- inline upstream key는 owner-only provider catalog에만 저장할 수 있다.
  environment key 값은 parent process environment에만 둔다.
- 두 credential 방식 모두 raw key를 safe app-server config, canonical hash,
  binding, state, event, error, log, argv, app-server child environment에
  복제하지 않는다. bridge가 request 시점에만 선택된 credential을 읽는다.
- inline key가 있는 catalog에 대해 파일이 current-user regular file이
  아니거나, 파일에 group/other permission bit가 있거나, catalog directory가
  owner-only가 아니면 `PROVIDER_CONFIG_INSECURE_PERMISSIONS`로 실행 전
  실패한다. request마다 permission을 다시 확인하고 inline key를 다시 읽는다.
- app-server child에는 high-entropy bridge token만 전달한다.
- external child의 `CODEX_HOME` 기본값은
  `~/.ark-team/runs/<run-id>/external-codex-home`이다.
- custom adapter module은 project root 밖 absolute realpath, exact SHA-256,
  API version을 import 전에 검사한다.
- custom adapter는 trusted code이며 sandbox로 표현하지 않는다.

## 8. Compatibility and migration

- `.codex/team-orchestrator.toml`의 `version = 1`과 native model literal을
  변경하지 않는다.
- provider definitions와 credentials를 project config에 넣지 않는다.
  inline key는 user-owned provider catalog에서만 허용한다.
- 기존 `env_key` catalog는 그대로 유효하며 `inline_key`로 자동 변환하지
  않는다.
- old assignment에 binding이 없으면 role의 native binding만 복원한다.
- external run resume는 redacted provider config와 adapter hash가 같을 때만
  허용한다. inline key 값만 회전하면 drift로 보지 않고 다음 request부터
  현재 값을 사용하며, `auth_kind`나 non-secret config 변경은 drift이다.
- native Luna path의 user-level auth/state behavior는 이번 slice에서
  migration하지 않는다.
- external path는 user `~/.codex/config.toml`을 읽거나 쓰는 provider source로
  사용하지 않는다.
- 기존 `~/.codex/team-orchestrator/runs` record는 자동 이동하거나 삭제하지
  않는다.

## 9. OpenCodex porting warnings

- package internal import를 stable SDK로 가정하지 않는다.
- source attribution과 MIT notice를 derived source 근처와 third-party notice에
  보존한다.
- `openai-chat` request builder의 current `text.format` gap을 그대로 복제하지
  않는다.
- provider registry의 model lists는 복사하지 않는다.
- streaming tool call assembly, reasoning replay, usage, bounded error behavior를
  fixture로 고정한다.

## 10. Policy warning

Z.AI Coding Plan의 current public 문서는 지원 도구 밖의 subscription 사용을
제한한다. Ark Team/Codex bridge는 확인된 supported-tool 목록에 없으므로
SLICE-001 검증에 Coding Plan credential을 사용하지 않는다.

Z.AI provider를 기술적으로 설정하는 offline fixture는 `policy = "blocked"`로
허용하지만 Coding Plan credential의 live activation은
`PROVIDER_POLICY_BLOCKED`여야 한다. 일반 Open Platform API key billing
endpoint는 Coding Plan endpoint와 별도이며 generic `openai-chat` 계약으로
표현할 수 있지만, 실제 유료 smoke test는 사용자의 명시적 승인 없이는
실행하지 않는다.

## 11. Rollback

- run에서 external override를 제거하면 다음 새 run은 native Luna를 사용한다.
- in-flight/existing external run을 native로 전환하지 않는다.
- failed external run state와 redacted diagnostics를 보존한다.
- provider bridge와 external child를 close하되 user Codex state를 정리하거나
  삭제하지 않는다.
- custom/builtin adapter registration rollback은 기존 binding을 silently
  재해석하지 않고 resume를 drift error로 중단한다.

## 12. Prohibited assumptions

- Claude subscription이 Anthropic API key billing을 포함한다고 가정하지 않는다.
- Z.AI Coding Plan이 arbitrary proxy/SDK 사용을 허용한다고 가정하지 않는다.
- OpenAI-compatible provider가 `response_format`, reasoning, parallel tools,
  images를 모두 지원한다고 가정하지 않는다.
- model ID와 context window를 pinned OpenCodex registry가 계속 보장한다고
  가정하지 않는다.
- SHA-256 검증이 custom adapter를 sandbox한다고 가정하지 않는다.
- Codex SDK thread options가 per-thread provider를 지원한다고 가정하지 않는다.
- provider failure 시 Luna가 안전한 fallback이라고 가정하지 않는다.
- catalog가 owner-only라는 사실만으로 plaintext key가 version control,
  backup, 동기화 도구에서 자동 제외된다고 가정하지 않는다.

## 13. Spec delta 반환 형식

구현 중 계약 누락, Codex schema mismatch, adapter capability contradiction,
provider policy 변화가 발견되면 behavior를 임의 수정하지 말고 다음을 반환한다.

```text
SPEC_DELTA_REQUIRED
- affected IDs:
- observed evidence:
- contradiction or missing contract:
- proposed minimal change:
- affected AC/TEST/SLICE:
- safety/compatibility impact:
```
