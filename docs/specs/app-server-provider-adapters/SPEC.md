# Ark Team App-Server Provider Adapters — Implementation Specification

- Spec identity: `ark-team-provider-adapters-v1.0.0`
- Status: `SPEC_APPROVED_WITH_WARNINGS`
- Authority date: 2026-07-26 UTC
- Authority: 사용자가 승인한 대화 요구사항과 이 문서의 명시적 결정
- Target workspace: `/home/elicie/Dev/arc`
- Package shape: `SPEC.md`, `HANDOFF.md`, `STATUS.md`
- Reference boundary: `NONE`
- Discovery mode: `STATIC_AND_TESTS`
- Source drift policy: `PIN_INITIAL_SNAPSHOT`

## 1. 목적과 성공 신호

### OBJ-001 — Codex 전역 설정과 분리된 provider 관리

Ark Team은 외부 model provider의 endpoint, adapter, credential 참조를
`~/.codex/config.toml`에 저장하거나 수정하지 않고 별도의 Ark-owned provider
catalog에서 관리해야 한다.

### OBJ-002 — Luna worker 슬롯의 명시적 외부 모델 대체

외부 provider가 명시적으로 선택된 run에서는 현재
`gpt-5.6-luna`가 담당하는 `worker` 역할을 선택된 `provider + model +
reasoning effort` 조합으로 실행해야 한다. 외부 선택이 없는 run은 현재
Luna 동작을 그대로 유지해야 한다.

### OBJ-003 — OpenCodex의 최소 adapter 재사용과 확장

OpenCodex 전체 제품, CLI, GUI, provider 관리 서버를 설치하지 않고 Responses
변환에 필요한 최소 adapter 로직만 Ark runtime 안으로 이식한다. 기본 adapter와
동일한 계약으로 신뢰된 custom adapter를 등록할 수 있어야 한다.

### OBJ-004 — 재현 가능한 resume, 실패 격리, 비밀 보호

한 assignment가 시작한 provider, model, adapter revision은 resume과 retry에서
변경되지 않아야 한다. credential은 저장·로그하지 않으며 provider 실패를 Luna나
다른 provider로 자동 fallback하지 않아야 한다.

성공 신호는 다음과 같다.

1. 외부 선택이 없으면 기존 worker가 `gpt-5.6-luna / xhigh`로 동작한다.
2. 외부 선택이 있으면 app-server의 `thread/start`와 `thread/resume`에 동일한
   `modelProvider`와 `model`이 전달되고 응답에서도 검증된다.
3. text, reasoning, tool call, usage, structured worker report가 Responses 의미를
   유지한 채 왕복한다.
4. builtin `openai-chat`, `anthropic`, `google`, `openai-responses`와
   `custom:<id>`가 동일한 registry를 통해 선택된다.
5. 실행 전후 사용자 `~/.codex/config.toml`이 변경되지 않는다.

## 2. 근거 identity와 탐색 범위

### 2.1 로컬 Ark Team

- Source kind: `GIT_REPOSITORY`
- Source ID: `GIT-COMMIT:50531832a57e3fd0dae093b7ad0b51197e668045`
- Git tree: `de77e16a2c257456721bd44fc260f6b90afd2af6`
- Branch label at capture: `main`
- Worktree state at capture: `clean`
- Expected post-capture changes: 이 spec package의 문서 세 개

확인한 핵심 surface:

| Surface | 상태 | 근거 | 확인 내용 |
| --- | --- | --- | --- |
| `.codex/team-orchestrator.toml` | EXPLORED | SOURCE | PM/Terra/Luna 모델과 외부 모델 안전정책이 고정됨 |
| `project-config.ts` | EXPLORED | SOURCE, TEST | 모델이 literal로 고정되고 secret-bearing project config가 거부됨 |
| `managed-session.ts` | EXPLORED | SOURCE, TEST | 역할 정책과 모델이 결합되어 있고 PM은 SDK 경로를 사용함 |
| `assignment-scheduler.ts` | EXPLORED | SOURCE, TEST | PL/worker assignment가 `AppServerApprovalSession`으로 실행됨 |
| `app-server-client.ts` | EXPLORED | SOURCE, TEST | stdio app-server가 strict CLI override와 함께 실행됨 |
| `approval-session.ts` | EXPLORED | SOURCE, TEST | `thread/start/resume`, turn, approval, model 검증 경로가 존재함 |
| `domain.ts`, `state-store.ts` | EXPLORED | SOURCE, TEST | assignment가 session/turn을 저장하지만 provider binding은 저장하지 않음 |
| Codex app-server generated schema | EXPLORED | GENERATED SOURCE | CLI 0.145.0에서 start/resume params와 responses에 `modelProvider`가 존재함 |
| Runtime scripts/tests | EXPLORED | SOURCE, TEST | 현재 typecheck, build, unit, MCP, schema 검증 명령을 확인함 |
| 실제 외부 provider 호출 | OUT_OF_SCOPE | NOT EXECUTED | credential 사용과 과금/정책 영향을 피하기 위해 실행하지 않음 |

### 2.2 OpenCodex reference

- Origin: [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)
- Source ID:
  `GIT-COMMIT:ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`
- Tag: `v2.7.41`
- Package version: `2.7.41`
- License observed at pinned revision: MIT
- Drift policy: 구현과 porting은 이 commit만 기준으로 하고 최신 `main`을 섞지
  않는다. 새 revision을 사용하려면 spec delta와 adapter conformance 재검증이
  필요하다.

참고 surface:

| Surface | 상태 | 채택 결정 |
| --- | --- | --- |
| `src/adapters/base.ts` | EXPLORED | `ProviderAdapter`의 build/parse/error 경계를 ADAPT |
| `src/adapters/openai-chat.ts` | EXPLORED | message/tool/reasoning/stream 변환을 ADAPT |
| `src/adapters/anthropic.ts` | EXPLORED | Anthropic Messages, thinking, tool, stream 변환을 ADAPT |
| `src/adapters/google.ts` | PARTIAL | Google wire adapter를 별도 slice에서 ADAPT |
| `src/adapters/openai-responses.ts` | PARTIAL | Responses passthrough를 별도 slice에서 ADAPT |
| `src/providers/registry.ts` | EXPLORED | provider 예시와 model quirk만 참고하고 정적 catalog 전체는 REMOVE |
| CLI, GUI, management API, config mutation | EXPLORED | REMOVE |
| OAuth account flow와 token store | PARTIAL | DEFER |
| local history/resume sync | EXPLORED | REMOVE |

Pinned source:

- [adapter base](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/src/adapters/base.ts)
- [OpenAI Chat adapter](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/src/adapters/openai-chat.ts)
- [Anthropic adapter](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/src/adapters/anthropic.ts)
- [Google adapter](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/src/adapters/google.ts)
- [Responses adapter](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/src/adapters/openai-responses.ts)
- [provider registry](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/src/providers/registry.ts)
- [license](https://github.com/lidge-jun/opencodex/blob/ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10/LICENSE)

### 2.3 Codex와 provider 정책 근거

- Codex custom model provider는 `base_url`, `wire_api`, `env_key` 등을
  지원하며 현재 공식 문서는 custom provider의 wire API를 Responses로 설명한다.
- 설치된 Codex CLI `0.145.0` generated TypeScript schema에서
  `ThreadStartParams.modelProvider?`, `ThreadResumeParams.modelProvider?`,
  그리고 두 response의 필수 `modelProvider`를 확인했다.
- Z.AI Coding Plan 문서는 지원 도구 밖의 subscription quota 사용을 제한한다.
  2026-07-26 확인 시 지원 목록에 Codex 또는 Ark Team은 없었다.

References:

- [Codex custom model providers](https://developers.openai.com/codex/config-advanced/#custom-model-providers)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Z.AI supported tools and endpoints](https://docs.z.ai/devpack/tool/others)
- [Z.AI Coding Plan usage policy](https://docs.z.ai/devpack/usage-policy)
- [Z.AI subscription usage rules](https://docs.z.ai/legal-agreement/subscription-terms)

## 3. 범위

### 포함

- Ark-owned provider catalog와 strict schema
- environment-referenced credential
- run 요청의 `worker` external model override
- run/assignment provider binding snapshot
- authenticated process-local Responses bridge
- app-server provider CLI injection과 per-thread `modelProvider`
- builtin adapters:
  - `builtin:openai-chat`
  - `builtin:anthropic`
  - `builtin:google`
  - `builtin:openai-responses`
- trusted ESM custom adapter V1
- worker start/resume/retry, approval, output contract와 usage 기록
- fake upstream contract/integration tests
- pinned OpenCodex attribution

### 제외

- OpenCodex package를 runtime dependency로 직접 import
- OpenCodex CLI, GUI, management server, history sync, config patching
- always-on proxy/daemon 또는 독립 sidecar 프로세스
- `~/.codex/config.toml`에 provider를 쓰는 동작
- 외부 provider 사이의 자동 routing 또는 fallback
- provider model list를 OpenCodex 정적 목록으로 고정
- 임의 프로젝트 파일에서 custom adapter 자동 로드
- PM SDK backend의 provider 전환
- Claude account OAuth login/token 저장·갱신
- Z.AI Coding Plan의 정책 확인 없는 live activation
- Docker, 배포, 공용 네트워크 listener

PL과 integration PL의 외부 provider 선택은 동일한 app-server transport를
재사용할 수 있지만 이번 package의 승인 slice에는 포함하지 않는다.

## 4. 사실, 결정, 가정, 미확정

### 사실

- `worker`의 현재 모델은 `gpt-5.6-luna`, reasoning effort는 `xhigh`다.
- PL/worker assignment는 stdio Codex app-server를 사용하고 PM은 Codex SDK를
  사용한다.
- current `threadStartResponseSchema`는 model을 검증하지만 provider를 검증하지
  않는다.
- current assignment record는 session과 turn을 저장하지만 provider/model
  binding을 저장하지 않는다.
- OpenCodex는 Anthropic OAuth와 API-key provider를 모두 등록하지만 두 경로
  모두 `anthropic` adapter를 사용한다.
- pinned OpenCodex `openai-chat` adapter의 request builder는 Responses
  `text.format`을 upstream `response_format`으로 전달하지 않는다.
- OpenCodex package의 public export는 안정적인 adapter SDK 계약으로 문서화돼
  있지 않다.

### 결정

- `DEC-001`: provider catalog는 `ARK_TEAM_PROVIDER_CONFIG`가 가리키는 절대
  TOML 파일이다. 외부 provider를 선택하지 않으면 이 변수가 없어도 된다.
- `DEC-002`: project `.codex/team-orchestrator.toml`은 provider credential
  저장소가 아니며 현재 native model defaults를 유지한다.
- `DEC-003`: 외부 모델은 run 입력의 explicit role override로만 활성화한다.
- `DEC-004`: external worker app-server는 Ark state root 아래의 isolated
  `CODEX_HOME`을 사용한다. native Luna 경로는 호환성 보존을 위해 현행을
  유지한다.
- `DEC-005`: bridge는 Ark runtime 안에서 lazy-start하는 process-local
  component다. 별도 OpenCodex process를 시작하지 않는다.
- `DEC-006`: bridge는 보안상 `127.0.0.1`에만 bind하고 port `10001` 이상에서
  다음 가용 port를 선택한다. 이 loopback 제한은 credential-bearing internal
  endpoint를 외부에 노출하지 않기 위한 명시적 보안 요구사항이다.
- `DEC-007`: app-server child에는 upstream credential이 아니라 session별
  bridge bearer token만 전달한다.
- `DEC-008`: provider/adapter/model/reasoning 선택은 assignment 생성 전에
  해석하고 resume/retry에서 재해석하지 않는다.
- `DEC-009`: unsupported capability와 reasoning mapping은 자동 downgrade하지
  않고 fail closed한다. 명시적 mapping만 허용한다.
- `DEC-010`: builtin adapter 구현은 pinned OpenCodex 코드를 port하고 필요한
  라이선스 고지를 유지하되 Ark-owned V1 계약으로 감싼다.
- `DEC-011`: custom adapter는 trusted executable code다. hash pinning은
  무결성 제어이지 sandbox가 아니다.
- `DEC-012`: Claude는 API key 경로부터 지원한다. Claude account OAuth는
  별도 credential-lifecycle slice다.

### 가정

- Node.js 18 이상과 현재 project TypeScript toolchain을 유지한다.
- external provider는 Codex app-server가 요구하는 Responses 의미를 bridge를
  통해 충족할 수 있다.
- 외부 provider의 정확한 model ID는 operator/run caller가 제공하고 provider
  자체 약관과 접근권한을 보유한다.

### 미확정

- `Q-001`: Claude account OAuth를 후속 범위로 승인할지 여부.
- `Q-002`: worker 이후 PL/integration PL/PM에 같은 override를 확장할지 여부.
- `Q-003`: Z.AI가 Ark Team/Codex bridge를 Coding Plan 지원 도구로 서면
  승인할지 여부.

세 항목 모두 승인 slice 001–004를 막지 않는다. `Q-003`은 Z.AI Coding Plan
live activation slice만 막는다.

## 5. 용어

- **Provider catalog**: endpoint, adapter ID, credential environment variable,
  capability와 quirk를 정의하는 Ark-owned TOML.
- **Model binding**: 한 역할에 대해 확정된 provider, adapter, model,
  requested/effective reasoning effort의 불변 조합.
- **Bridge**: app-server가 보내는 Responses 요청을 받아 adapter로 upstream
  요청을 만들고 결과를 Responses event로 되돌리는 process-local HTTP
  component.
- **Builtin adapter**: Ark runtime에 compile된 adapter.
- **Custom adapter**: operator가 provider catalog에 절대 경로와 SHA-256으로
  등록한 trusted ESM module.
- **Native binding**: 현재 Codex/OpenAI 모델을 bridge 없이 사용하는 binding.
- **External binding**: Ark bridge와 custom app-server provider를 사용하는
  binding.
- **Validated JSON**: upstream native schema 강제가 없더라도 Ark의 기존 output
  schema validation과 correction budget으로 검증하는 structured-output mode.

## 6. 목표 architecture

```text
Ark Team controller
  ├─ ProviderCatalog
  ├─ AdapterRegistry
  │    ├─ builtin:openai-chat
  │    ├─ builtin:anthropic
  │    ├─ builtin:google
  │    ├─ builtin:openai-responses
  │    └─ custom:<id>
  ├─ ProviderBridge (in-process, authenticated loopback)
  └─ AppServerApprovalSession
       └─ codex app-server --listen stdio:// --strict-config
            └─ modelProvider: ark_<provider-id>
                 └─ Responses → ProviderBridge → upstream provider
```

Native worker:

```text
worker → openai/native → gpt-5.6-luna / xhigh
```

External worker:

```text
worker → ark_<provider> → selected model/effective effort
       → Ark ProviderBridge → selected adapter → upstream
```

## 7. Provider catalog contract

### 7.1 위치와 lifecycle

- `ARK_TEAM_PROVIDER_CONFIG`는 absolute path여야 한다.
- 외부 provider override가 존재할 때 변수가 없거나 파일을 읽을 수 없으면
  session을 시작하기 전에 실패한다.
- catalog는 run 시작 시 strict parse하고 canonical bytes의 SHA-256을 run에
  저장한다.
- restart/resume 시 같은 catalog hash가 아니면
  `PROVIDER_CONFIG_DRIFT`로 pause한다. 변경된 설정을 기존 session에 적용하지
  않는다.
- raw credential value는 hash, snapshot, event, error에 포함하지 않는다.

### 7.2 예시 schema

```toml
version = 1

[providers.zai]
adapter = "builtin:openai-chat"
base_url = "https://api.z.ai/api/coding/paas/v4"
auth_kind = "env_key"
api_key_env = "ZAI_API_KEY"
structured_output_mode = "validated_json"
model_suffix_bracket_strip = true
policy = "blocked"

[providers.anthropic_api]
adapter = "builtin:anthropic"
base_url = "https://api.anthropic.com"
auth_kind = "env_key"
api_key_env = "ANTHROPIC_API_KEY"
structured_output_mode = "validated_json"
policy = "standard"

[providers.company_ai]
adapter = "custom:company"
base_url = "https://ai.company.example/api"
auth_kind = "env_key"
api_key_env = "COMPANY_AI_API_KEY"
structured_output_mode = "native_json_schema"
policy = "standard"

[providers.company_ai.reasoning_effort_map]
xhigh = "high"

[adapters.company]
module = "/opt/ark-team/adapters/company.mjs"
export = "createAdapter"
api_version = 1
sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

### 7.3 validation

- provider/adapter ID는 `[a-z][a-z0-9_]{0,62}`와 일치해야 한다.
- `adapter`는 `builtin:<known-id>` 또는 `custom:<registered-id>`다.
- `base_url`에 userinfo, fragment, embedded credential이 있으면 거부한다.
- HTTPS가 기본이다. private/local HTTP upstream은
  `allow_private_network = true`가 명시된 provider만 허용한다.
- `api_key_env`는 environment variable 이름만 허용하고 값은 허용하지 않는다.
- `auth_kind`는 initial scope에서 `env_key` 또는 `none`이다.
- `policy`는 `standard` 또는 `blocked`다. `blocked` provider는 network request
  전에 `PROVIDER_POLICY_BLOCKED`로 중단한다. 다른 승인 형태는 후속 spec
  delta 없이는 추가하지 않는다.
- `allowed_models`가 있으면 exact model ID allowlist로 사용한다. 없으면 caller가
  제공한 exact model ID를 허용한다.
- OpenCodex의 정적 model 목록은 authoritative allowlist로 import하지 않는다.
- reasoning effort mapping은 명시적으로 선언된 값만 적용하며 requested/effective
  값을 모두 snapshot한다.
- unknown key는 거부한다.

## 8. Run model-selection contract

external 선택은 project config의 implicit default가 아니라 execute/start 요청의
optional field로 전달한다.

```ts
interface ExternalModelOverride {
  provider: string;
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";
}

interface ModelOverrides {
  worker?: ExternalModelOverride;
}
```

선택 순서:

```text
run의 explicit worker override
  → 있으면 external binding
  → 없으면 managedRoleProfiles.worker의 native Luna binding
```

`external_models.explicit_request_only = true`와
`automatic_luna_fallback = false`는 계속 고정한다. runtime caller는 사용자가
외부 모델을 명시적으로 요청한 경우에만 override를 전달해야 한다.

binding snapshot 최소 필드:

```ts
interface NativeModelBindingSnapshotV1 {
  schema_version: 1;
  kind: "native";
  provider_id: "openai";
  model: string;
  requested_reasoning_effort: string;
  effective_reasoning_effort: string;
}

interface ExternalModelBindingSnapshotV1 {
  schema_version: 1;
  kind: "external";
  provider_id: string;
  app_server_provider_id: string;
  adapter_id: string;
  adapter_api_version: 1;
  adapter_sha256: string | null;
  provider_config_sha256: string;
  model: string;
  requested_reasoning_effort: string;
  effective_reasoning_effort: string;
  structured_output_mode:
    | "native_json_schema"
    | "validated_json";
}

type ResolvedModelBindingV1 =
  | NativeModelBindingSnapshotV1
  | ExternalModelBindingSnapshotV1;
```

native binding은 provider credential이나 bridge metadata를 갖지 않는다.

새 assignment는 run의 resolved role binding을 복사한다. old persisted
assignment에 binding이 없으면 현재 고정 역할 profile에서 native binding만
복원한다. old record에 external binding을 추론해서는 안 된다.

## 9. Adapter V1 contract

Ark-owned interface의 normative shape:

```ts
interface ProviderAdapterV1 {
  readonly apiVersion: 1;
  readonly id: string;

  capabilities(config: SafeProviderConfig): ProviderCapabilities;
  validateConfig(config: SafeProviderConfig): void;

  buildRequest(
    request: NormalizedResponsesRequest,
    context: AdapterContext,
  ): UpstreamRequest | Promise<UpstreamRequest>;

  parseStream(
    response: Response,
    context: AdapterContext,
  ): AsyncIterable<NormalizedResponseEvent>;

  parseResponse?(
    response: Response,
    context: AdapterContext,
  ): Promise<NormalizedResponseEvent[]>;

  formatError?(
    status: number,
    headers: Headers,
    body: string,
  ): NormalizedProviderError;
}
```

필수 capability:

```ts
interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallel_tools: boolean;
  reasoning: boolean;
  images: boolean;
  structured_output:
    | "native_json_schema"
    | "validated_json"
    | "unsupported";
}
```

normalized event는 최소한 다음 의미를 표현해야 한다.

- response created/in-progress/completed/failed
- output item added/completed
- text delta/done
- reasoning delta/done
- function call name/arguments/done
- input/output/cached/reasoning usage
- provider error와 incomplete reason

Bridge가 normalized event를 Codex-compatible Responses SSE/JSON으로 encoding한다.
adapter가 raw provider event를 app-server에 직접 노출하지 않는다.

### 9.1 Builtin adapters

- `builtin:openai-chat`: Responses message/history/tool/reasoning을 Chat
  Completions로 변환하고 streamed tool call fragments를 원자적 tool call로
  조립한다.
- `builtin:anthropic`: Anthropic Messages의 system/message/tool_use/tool_result,
  thinking, prompt caching 호환, stream, usage를 처리한다. initial auth는 API
  key다.
- `builtin:google`: Google content/parts/function calling/thinking/usage를
  처리한다.
- `builtin:openai-responses`: Responses-compatible upstream에 필요한 검증과
  redacted passthrough를 제공한다.

`builtin:openai-chat`은 pinned OpenCodex 구현에 없는 `text.format` 처리를
보완해야 한다.

- `native_json_schema`: upstream이 지원하면 Responses `text.format`을
  `response_format` 또는 provider-native equivalent로 전달한다.
- `validated_json`: schema를 deterministic instruction으로 전달하고 Ark의
  기존 `parseManagedOutput` validation/correction을 최종 권위로 사용한다.
- `unsupported`: managed worker output contract가 있으면 request 전에 실패한다.

### 9.2 Custom adapter

- module은 absolute path의 regular ESM file이어야 한다.
- `realpath`를 해석한 뒤 active project root 아래면 거부한다.
- import 전에 exact SHA-256을 검증한다.
- module은 catalog의 named export에서
  `createAdapter(): ProviderAdapterV1`을 제공해야 한다.
- `apiVersion !== 1`, duplicate ID, missing method, capability contradiction은
  load 전에 거부한다.
- module은 process 안에서 실행되므로 filesystem/network sandbox를 제공한다고
  주장하지 않는다. operator가 설치한 trusted code만 허용한다.
- hot reload를 하지 않는다. adapter file이나 hash가 달라지면 새 run/spec
  delta가 필요하고 기존 run은 resume하지 않는다.

## 10. Provider bridge와 app-server contract

### 10.1 Bridge

- 외부 worker가 처음 필요할 때 lazy-start한다.
- `127.0.0.1`에만 bind한다.
- port는 `10001`부터 다음 가용 port를 선택하고 선택값을 run diagnostics에
  기록한다. port `3000`은 금지한다.
- provider별 route는 `/v1/providers/<provider-id>` 아래에 둔다.
- high-entropy bearer token 없이는 모든 request를 거부한다.
- token은 assignment/app-server child별로 발급하고 child environment에만
  넣는다.
- upstream credential은 bridge 내부에서 `api_key_env`로 resolve하며
  app-server child에 전달하지 않는다.
- provider path/query, authorization header, raw request/response body를
  일반 log에 기록하지 않는다.
- last external session이 끝나면 listener를 종료할 수 있다. always-on daemon은
  허용하지 않는다.

### 10.2 app-server injection

external session의 `StdioAppServerClient`는 shell 없이 argv로 다음 의미의
override를 전달한다.

```text
model_providers.ark_<provider-id>.name = "Ark external provider"
model_providers.ark_<provider-id>.base_url =
  "http://127.0.0.1:<port>/v1/providers/<provider-id>"
model_providers.ark_<provider-id>.wire_api = "responses"
model_providers.ark_<provider-id>.env_key = "<child-only bridge token env name>"
```

raw token 값과 upstream credential은 argv에 넣지 않는다. 기존
`--listen stdio://`, `--strict-config`, disabled agents/apps/multi-agent 설정을
유지한다.

external app-server child는
`$ARK_TEAM_STATE_ROOT/runs/<run-id>/external-codex-home`을 `CODEX_HOME`으로
사용한다. directory는 owner-only 권한으로 만들고 같은 run의 resume에서
재사용한다. 사용자 `~/.codex`를 provider 설정이나 external session state에
사용하지 않는다.

`thread/start`와 `thread/resume`은 다음을 포함한다.

```json
{
  "modelProvider": "ark_<provider-id>",
  "model": "<binding model>",
  "config": {
    "model_reasoning_effort": "<effective effort>"
  }
}
```

response의 `model`, `modelProvider`, cwd, sandbox, resumed thread ID를 모두
검증한다. `model/rerouted`가 선택된 binding을 변경하면
`AGENT_SESSION_PROTOCOL_ERROR`로 실패한다.

## 11. Worker 적용과 상태 전이

1. controller가 run 요청의 worker override 존재 여부를 확인한다.
2. 없으면 현재 Luna binding을 snapshot하고 기존 경로를 유지한다.
3. 있으면 provider catalog, credential presence, adapter hash/API,
   model allowlist, reasoning mapping, structured-output capability를 preflight한다.
4. resolved external binding과 catalog hash를 run에 저장한다.
5. worker assignment 생성 시 binding을 assignment에 복사하고
   `assignment.provider_selected` event를 기록한다.
6. scheduler가 binding을 `AppServerApprovalSession`에 전달한다.
7. session이 bridge와 external app-server provider를 준비한 뒤 thread를
   시작한다.
8. approval, correction, retry budget과 output validation은 현행 계약을
   유지한다.
9. resume와 correction은 저장된 thread와 binding을 사용한다.
10. fresh-session retry도 동일 binding을 사용한다.

외부 provider의 세 번 재시도가 모두 실패하면 기존 정책대로 pause하고
사용자에게 `retry_once` 또는 `cancel_run`을 요청한다. provider나 Luna로
fallback하지 않는다.

## 12. 오류와 관측 계약

신규 error code:

| Code | 의미 |
| --- | --- |
| `PROVIDER_CONFIG_UNAVAILABLE` | required catalog를 읽을 수 없음 |
| `PROVIDER_CONFIG_INVALID` | schema, URL, ID, unknown key가 유효하지 않음 |
| `PROVIDER_CONFIG_DRIFT` | resume 시 catalog hash가 변경됨 |
| `PROVIDER_NOT_FOUND` | override provider가 catalog에 없음 |
| `PROVIDER_CREDENTIAL_MISSING` | required environment credential이 없음 |
| `PROVIDER_CAPABILITY_UNSUPPORTED` | tools/reasoning/structured output 요구를 충족하지 못함 |
| `ADAPTER_NOT_FOUND` | builtin 또는 custom adapter가 없음 |
| `ADAPTER_HASH_MISMATCH` | custom module hash가 catalog와 다름 |
| `ADAPTER_API_VERSION_UNSUPPORTED` | custom contract version이 다름 |
| `PROVIDER_BRIDGE_UNAVAILABLE` | listener/token/upstream transport 준비 실패 |
| `PROVIDER_RESPONSE_INVALID` | upstream response/event가 변환 불가능함 |
| `PROVIDER_POLICY_BLOCKED` | subscription/provider 정책상 live activation이 금지됨 |

event/log에 허용되는 정보:

- provider ID와 adapter ID
- model ID
- requested/effective reasoning effort
- adapter API version과 custom adapter SHA-256
- provider config SHA-256
- retry count, redacted error code/message
- usage

금지되는 정보:

- API key, OAuth token, bridge token
- raw Authorization/header
- credential-bearing URL/userinfo/query
- unrestricted upstream request/response body
- private reasoning

structured output invalid response는 full body 대신 byte length, SHA-256,
bounded issues만 저장한다.

## 13. Security, reliability, compatibility, operations

### Security

- project-controlled config에서 executable custom adapter path를 읽지 않는다.
- custom module hash를 import 전에 검증한다.
- bridge는 loopback과 bearer auth를 동시에 요구한다.
- child argv와 logs에 secrets를 넣지 않는다.
- base URL은 HTTPS를 기본으로 하고 private network opt-in을 요구한다.
- custom adapter는 trusted code이며 sandbox가 아니라는 사실을 문서와 error에
  명확히 한다.

### Reliability

- request timeout, stream idle timeout, abort signal을 upstream fetch와 stream
  consumer까지 전달한다.
- partial streamed tool call은 terminal signal 전에 완료된 call로 emit하지
  않는다.
- provider errors는 bounded/redacted 형태로 변환한다.
- bridge shutdown은 live session을 먼저 interrupt/close한 후 수행한다.
- adapter/config drift가 있으면 기존 session을 다른 구현으로 이어가지 않는다.

### Compatibility

- no override run의 Sol/Terra/Luna model contract와 current approval behavior를
  변경하지 않는다.
- old assignment record에 binding이 없으면 native 역할 binding으로만 읽는다.
- project config `version = 1`과 fixed model defaults를 변경하지 않는다.
- `verify-app-server-schema`에 `modelProvider` 필드와 custom provider config
  compatibility 검사를 추가한다.
- external path는 installed Codex CLI `0.145.0` baseline에서 검증하고 향후 CLI
  변경은 schema gate로 차단한다.

### Operations

- Docker나 shared infra service는 필요하지 않다.
- bridge는 Ark process-local이고 외부에 publish하지 않는다.
- fake upstream contract tests가 기본 verification이다.
- real provider smoke test는 credential 소유자가 명시적으로 승인했을 때만
  별도 실행한다.
- 비용 또는 subscription quota를 소비하는 test는 기본 `npm test`에 포함하지
  않는다.

## 14. Normative requirements

### REQ-001 — 별도 provider catalog와 secret 참조

- Level: MUST
- Source: USER_REQUIREMENT, DEC-001, DEC-002
- Actors: operator, ProviderCatalog
- Preconditions: external override가 요청됨
- Trigger: run이 binding을 해석함
- Observable result: absolute Ark provider catalog를 strict parse하고 credential
  값이 아닌 environment variable 이름만 사용함
- State/error behavior: missing/invalid catalog 또는 credential은 session 시작 전
  명시적 provider error로 실패함
- Permissions/privacy: 사용자 Codex config를 쓰지 않고 secret을 저장하지 않음
- Exclusions: project config credential
- Acceptance: AC-001
- Verification: TEST-001

### REQ-002 — Builtin/custom adapter registry

- Level: MUST
- Source: USER_REQUIREMENT, DEC-010, DEC-011
- Actors: AdapterRegistry, operator
- Preconditions: provider config가 adapter ID를 참조함
- Trigger: binding preflight
- Observable result: known builtin 또는 hash-pinned custom V1 adapter 하나가
  결정되고 capability가 반환됨
- State/error behavior: unknown, hash mismatch, API mismatch는 request 전에 실패함
- Permissions/privacy: project root의 executable module을 자동 로드하지 않음
- Exclusions: sandbox 보장, hot reload
- Acceptance: AC-002
- Verification: TEST-002

### REQ-003 — 명시적 worker selection과 native default

- Level: MUST
- Source: USER_REQUIREMENT, DEC-003
- Actors: controller, model-binding resolver
- Preconditions: run 요청과 fixed role profile이 존재함
- Trigger: run 생성
- Observable result: explicit override가 있을 때만 external binding을 선택하고
  없으면 `gpt-5.6-luna / xhigh`를 선택함
- State/error behavior: implicit provider default와 automatic fallback을 허용하지
  않음
- Permissions/privacy: override에 secret을 허용하지 않음
- Exclusions: PM/PL overrides
- Acceptance: AC-003
- Verification: TEST-003

### REQ-004 — 불변 binding snapshot

- Level: MUST
- Source: DEC-008
- Actors: RunStore, scheduler
- Preconditions: binding preflight가 성공함
- Trigger: run/assignment 생성, resume, retry
- Observable result: provider/adapter/model/effort/config hash를 저장하고 모든
  continuation에서 같은 값을 사용함
- State/error behavior: config/adapter drift는 pause/error이며 재해석하지 않음
- Permissions/privacy: credential value와 full credential URL을 저장하지 않음
- Exclusions: live config switching
- Acceptance: AC-004
- Verification: TEST-004

### REQ-005 — 인증된 process-local bridge

- Level: MUST
- Source: DEC-005, DEC-006, DEC-007
- Actors: ProviderBridge, app-server child
- Preconditions: valid external binding
- Trigger: first external assignment starts
- Observable result: authenticated `127.0.0.1` listener가 port 10001 이상에서
  시작되고 upstream credential은 bridge 안에서만 resolve됨
- State/error behavior: unauthenticated, malformed, wrong-provider request를 거부함
- Permissions/privacy: public/non-loopback bind와 raw secret logging 금지
- Exclusions: sidecar, daemon, Docker
- Acceptance: AC-005
- Verification: TEST-005

### REQ-006 — app-server provider 주입과 응답 검증

- Level: MUST
- Source: FACT, USER_REQUIREMENT
- Actors: StdioAppServerClient, AppServerApprovalSession
- Preconditions: bridge와 binding이 준비됨
- Trigger: external thread start/resume
- Observable result: Responses provider CLI config, `modelProvider`, model, effort를
  전달하고 response의 model/provider/cwd/sandbox/thread를 검증함
- State/error behavior: mismatch/reroute는 protocol error
- Permissions/privacy: raw token을 argv에 넣지 않음
- Exclusions: `~/.codex/config.toml` mutation
- Acceptance: AC-006
- Verification: TEST-006

### REQ-007 — Worker 역할 계약 보존

- Level: MUST
- Source: USER_REQUIREMENT
- Actors: worker, PL, scheduler
- Preconditions: external worker binding이 선택됨
- Trigger: worker assignment
- Observable result: `ark_worker` instructions, worktree, workspace-write sandbox,
  on-request approval, worker report contract는 유지되고 model binding만 교체됨
- State/error behavior: approval/correction/retry budget은 현행과 동일함
- Permissions/privacy: 외부 provider 선택이 권한 확대를 만들지 않음
- Exclusions: worker hierarchy 변경
- Acceptance: AC-007
- Verification: TEST-007

### REQ-008 — Builtin provider protocol 변환

- Level: MUST
- Source: USER_REQUIREMENT, OpenCodex reference
- Actors: builtin adapters, bridge
- Preconditions: corresponding builtin adapter가 선택됨
- Trigger: Responses request/response
- Observable result: OpenAI Chat, Anthropic, Google, Responses upstream의 text,
  tool, reasoning, usage, stream semantics가 normalized event로 변환됨
- State/error behavior: incomplete/invalid upstream event는 bounded provider error
- Permissions/privacy: provider payload를 일반 log에 저장하지 않음
- Exclusions: OpenCodex 전체 runtime
- Acceptance: AC-008
- Verification: TEST-008

### REQ-009 — Structured output와 capability preflight

- Level: MUST
- Source: FACT, DEC-009
- Actors: adapter, role-output validator
- Preconditions: worker output contract가 존재함
- Trigger: binding preflight와 request build
- Observable result: native schema 또는 validated JSON mode를 명시적으로 사용하고
  최종 worker report는 기존 strict schema를 통과함
- State/error behavior: unsupported capability/effort는 request 전에 실패하며
  silent downgrade하지 않음
- Permissions/privacy: invalid full response를 저장하지 않음
- Exclusions: schema 미검증 성공 처리
- Acceptance: AC-009
- Verification: TEST-009

### REQ-010 — Provider failure와 no-fallback

- Level: MUST
- Source: USER_REQUIREMENT, existing external policy
- Actors: scheduler, retry coordinator
- Preconditions: external assignment가 실패함
- Trigger: transport, upstream, adapter 또는 protocol failure
- Observable result: 동일 binding으로 최대 세 번 retry한 뒤 사용자 결정을
  기다림
- State/error behavior: Luna/다른 provider 자동 fallback 금지
- Permissions/privacy: redacted reason과 counters만 노출
- Exclusions: automatic router
- Acceptance: AC-010
- Verification: TEST-010

### REQ-011 — Audit와 redaction

- Level: MUST
- Source: SECURITY_DECISION
- Actors: RunStore, logger
- Preconditions: provider lifecycle event가 발생함
- Trigger: select/start/retry/complete/fail
- Observable result: provider/model/adapter/config hashes와 usage를 기록하고 secret,
  raw auth, private reasoning을 기록하지 않음
- State/error behavior: secret-bearing record는 schema에서 거부됨
- Permissions/privacy: bounded diagnostics
- Exclusions: raw payload archive
- Acceptance: AC-011
- Verification: TEST-011

### REQ-012 — Native 호환성과 사용자 Codex 상태 비변경

- Level: MUST
- Source: USER_REQUIREMENT, DEC-004
- Actors: native worker, external app-server child
- Preconditions: native 또는 external run
- Trigger: session lifecycle
- Observable result: native no-override behavior가 그대로 유지되고 external
  session은 isolated Ark `CODEX_HOME`을 사용함
- State/error behavior: old native records를 external로 오인하지 않음
- Permissions/privacy: external path가 사용자 Codex config/state를 쓰지 않음
- Exclusions: native auth/state migration
- Acceptance: AC-012
- Verification: TEST-012

### REQ-013 — OpenCodex provenance와 porting 경계

- Level: MUST
- Source: LICENSE_EVIDENCE, DEC-010
- Actors: implementer, reviewer
- Preconditions: OpenCodex-derived code가 추가됨
- Trigger: source addition/review
- Observable result: pinned commit, source path, MIT notice를 보존하고 불필요한
  OpenCodex product code를 포함하지 않음
- State/error behavior: 다른 upstream revision을 섞으면 spec drift
- Permissions/privacy: 해당 없음
- Exclusions: legal conclusion, unpinned latest code
- Acceptance: AC-013
- Verification: TEST-013

### REQ-014 — Subscription/provider policy gate

- Level: MUST
- Source: PROVIDER_DOCUMENT
- Actors: controller, operator
- Preconditions: provider가 subscription/tool restriction을 선언함
- Trigger: live activation
- Observable result: catalog가 policy gate를 요구하고 explicit authorization이
  없으면 `PROVIDER_POLICY_BLOCKED`로 중단함
- State/error behavior: fake tests와 general API-key provider는 독립적으로 검증
- Permissions/privacy: subscription credential을 시험 목적으로 자동 사용하지 않음
- Exclusions: 약관 적합성의 법률적 판단
- Acceptance: AC-014
- Verification: TEST-014

### REQ-015 — Codex/adapter conformance gate

- Level: MUST
- Source: FACT, RELIABILITY_DECISION
- Actors: verifier
- Preconditions: implementation 또는 Codex/adapter upgrade
- Trigger: test/build
- Observable result: generated app-server schema, adapter fixtures, fake upstream
  integration, native regression 검사가 모두 통과함
- State/error behavior: missing `modelProvider` 또는 event mismatch가 build를 실패시킴
- Permissions/privacy: live paid API를 기본 test에서 호출하지 않음
- Exclusions: unverified success claim
- Acceptance: AC-015
- Verification: TEST-015

## 15. Acceptance criteria

### AC-001

Given a valid catalog using environment references and an external override,
when the run resolves the provider, then it loads the provider without reading
a raw key from TOML. Missing variables, unknown keys, inline secrets, or invalid
URLs fail before app-server launch.

### AC-002

Given builtin and custom adapter registrations, when preflight resolves each
adapter, then builtin IDs resolve deterministically and a custom module loads
only after exact absolute-path, project-boundary, SHA-256, API-version, and
shape checks. Every negative case fails without executing the module.

### AC-003

Given two otherwise identical runs, when one omits a worker override and one
contains a valid override, then the first selects native
`gpt-5.6-luna/xhigh` and the second selects exactly the requested external
provider/model/effective effort. Neither run infers another selection.

### AC-004

Given an external assignment that has started, when catalog content, adapter
bytes, or current defaults change before resume, then resume uses the stored
binding only when hashes still match; otherwise it stops with drift and never
switches model/provider.

### AC-005

Given a prepared external binding, when the bridge starts, then it listens only
on `127.0.0.1` at a recorded port of at least 10001, rejects absent/wrong bearer
tokens, and keeps the upstream key out of the child environment and logs.

### AC-006

Given an external worker start and resume, when app-server requests are
captured, then both contain the expected `modelProvider` and model, the child
provider config uses `wire_api=responses`, and a response provider/model
mismatch or reroute fails deterministically.

### AC-007

Given native and external worker assignments, when their prompts, sandbox,
approval requests, worktree roots, correction handling, and reports are
compared, then only the model binding differs.

### AC-008

Given deterministic fixtures for each builtin adapter, when text, reasoning,
one/multiple tool calls, usage, terminal events, non-stream responses, and
upstream errors are parsed, then the expected normalized event sequence is
produced without dangling tool calls or secret leakage.

### AC-009

Given a worker output schema, when native-schema, validated-JSON, and
unsupported providers are exercised, then the first two can complete only
after Ark strict validation and the unsupported provider fails at preflight.
`text.format` is not silently discarded.

### AC-010

Given repeated external provider failures, when the retry budget is exhausted,
then every attempt retains the exact binding and the run waits for the existing
user retry decision. No native or alternate provider request is made.

### AC-011

Given a provider run containing canary secrets in keys, headers, URLs, and
errors, when persisted records and logs are scanned, then no canary appears;
provider/model/adapter hashes, usage, counters, and bounded errors remain
observable.

### AC-012

Given a clean no-override baseline and an external run, when both complete
their session lifecycle, then native Luna request fixtures remain byte-for-byte
compatible where not intentionally extended, the external child uses the
isolated run home, and user `~/.codex/config.toml` is unchanged.

### AC-013

Given OpenCodex-derived source files, when provenance is inspected, then each
derived area identifies tag `v2.7.41`, commit
`ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`, original source path, and MIT
notice, with no CLI/GUI/management/config-mutation code included.

### AC-014

Given the Z.AI Coding Plan catalog example, when live activation is requested
without provider confirmation or a separate written agreement, then the run
fails with `PROVIDER_POLICY_BLOCKED` before a quota-consuming request. Offline
adapter tests remain available.

### AC-015

Given Codex CLI 0.145.0 and the project toolchain, when the conformance suite
runs, then generated start/resume params and responses contain
`modelProvider`, all adapter contracts pass, fake app-server integration
passes, native regression passes, and no real paid provider is contacted.

## 16. Verification catalog

### TEST-001

- Covers: REQ-001, AC-001
- Level: unit, security
- Setup: temporary provider TOML and canary environment values
- Procedure: valid parse plus missing path/key, inline secret, unknown key,
  invalid/private URL cases
- Expected: valid safe config only; bounded error messages without canary
- Evidence: focused provider-config test output

### TEST-002

- Covers: REQ-002, AC-002
- Level: unit, security
- Setup: builtin registry and temporary ESM modules inside/outside project
- Procedure: resolve valid module; test wrong hash/version/export/path/symlink
- Expected: only the valid trusted module executes
- Evidence: adapter-registry test output and execution canary

### TEST-003

- Covers: REQ-003, AC-003
- Level: unit
- Setup: native default and explicit override inputs
- Procedure: resolve both and compare snapshots
- Expected: exact native/external bindings and no implicit selection
- Evidence: model-binding resolver fixture

### TEST-004

- Covers: REQ-004, AC-004
- Level: unit, recovery
- Setup: persisted run/assignment with binding and changed catalog/module
- Procedure: reopen, resume, retry, then introduce drift
- Expected: stable binding when hashes match; drift error otherwise
- Evidence: state-store reopen and recovery tests

### TEST-005

- Covers: REQ-005, AC-005
- Level: integration, security
- Setup: process-local bridge with fake upstream
- Procedure: inspect bind/port; send no/wrong/right token; inspect child env/logs
- Expected: only authenticated loopback request succeeds; no upstream secret leak
- Evidence: bridge integration test

### TEST-006

- Covers: REQ-006, AC-006
- Level: contract, integration
- Setup: fake app-server client plus real generated schema
- Procedure: capture start/resume; inject provider/model mismatch and reroute
- Expected: exact provider/model/config and deterministic mismatch failure
- Evidence: approval-session tests and schema verification output

### TEST-007

- Covers: REQ-007, AC-007
- Level: regression, integration
- Setup: native and external worker fixtures
- Procedure: compare prompt, cwd, sandbox, approval, output contract, corrections
- Expected: only binding/transport metadata differs
- Evidence: scheduler/approval-session regression tests

### TEST-008

- Covers: REQ-008, AC-008
- Level: contract
- Setup: pinned sanitized upstream request/stream/error fixtures
- Procedure: exercise every builtin adapter event family
- Expected: exact normalized sequences and bounded errors
- Evidence: adapter fixture snapshots

### TEST-009

- Covers: REQ-009, AC-009
- Level: contract, integration
- Setup: native-schema, validated-JSON, unsupported fake providers
- Procedure: send worker output schema and valid/invalid reports
- Expected: schema forwarding or deterministic instruction plus Ark validation;
  unsupported preflight rejection
- Evidence: structured-output adapter and correction tests

### TEST-010

- Covers: REQ-010, AC-010
- Level: integration
- Setup: fake upstream that fails every request
- Procedure: exhaust external retry budget and inspect all requests/state
- Expected: same binding each time, waiting_user after budget, zero fallback calls
- Evidence: retry-coordinator test and request capture

### TEST-011

- Covers: REQ-011, AC-011
- Level: security
- Setup: canaries in credential, header, endpoint query, upstream error/body
- Procedure: execute failure paths and recursively scan persisted state/logs
- Expected: no canary, required audit fields present
- Evidence: redaction test report

### TEST-012

- Covers: REQ-012, AC-012
- Level: regression, integration
- Setup: clean isolated user config fixture, native and external sessions
- Procedure: run both paths and compare config bytes/state roots
- Expected: native fixtures preserved; external uses Ark home; user config unchanged
- Evidence: before/after hashes and test assertions

### TEST-013

- Covers: REQ-013, AC-013
- Level: static inspection
- Setup: changed-source inventory
- Procedure: search attribution metadata and imported file graph
- Expected: pinned provenance/license and excluded product surfaces absent
- Evidence: provenance script output/review checklist

### TEST-014

- Covers: REQ-014, AC-014
- Level: policy, integration
- Setup: policy-gated Z.AI catalog with network spy
- Procedure: request live activation without authorization
- Expected: policy error and zero outbound request
- Evidence: policy-gate test and spy count

### TEST-015

- Covers: REQ-015, AC-015
- Level: contract, integration, regression
- Setup: installed Codex and project test toolchain
- Procedure: run schema check, focused tests, typecheck, build, full regression
- Expected: all pass without paid provider access
- Evidence: command outputs listed in HANDOFF

## 17. Vertical slices

### SLICE-001 — Generic external worker through app-server

- Status: APPROVED
- Objective: OBJ-001, OBJ-002, OBJ-004
- Includes: REQ-001, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007,
  REQ-009, REQ-010, REQ-011, REQ-012, REQ-015, and the
  `builtin:openai-chat` portion of REQ-008
- Acceptance: AC-001, AC-003, AC-004, AC-005, AC-006, AC-007, AC-009,
  AC-010, AC-011, AC-012, AC-015
- Verification: TEST-001, TEST-003, TEST-004, TEST-005, TEST-006, TEST-007,
  TEST-009, TEST-010, TEST-011, TEST-012, TEST-015
- Dependencies: Codex CLI 0.145.0 baseline, current app-server worker path
- Excludes: real paid provider, custom module, Anthropic/Google, OAuth
- External contracts affected: execute input, persisted run/assignment,
  app-server provider/start/resume
- Rollback/recovery: omit override and use native Luna; preserve external run
  state for diagnosis
- Completion rule: fake OpenAI-compatible upstream에서 worker structured report가
  app-server end-to-end로 완료되고 native regression과 no-global-config 검사가
  통과함

### SLICE-002 — Claude API-key worker

- Status: APPROVED
- Objective: OBJ-003, OBJ-004
- Includes: Anthropic portion of REQ-008, REQ-009, REQ-010, REQ-011,
  REQ-013, REQ-015
- Acceptance: AC-008, AC-009, AC-010, AC-011, AC-013, AC-015
- Verification: TEST-008, TEST-009, TEST-010, TEST-011, TEST-013, TEST-015
- Dependencies: SLICE-001
- Excludes: Claude account OAuth
- External contracts affected: builtin adapter registry and provider catalog
- Rollback/recovery: remove Anthropic builtin registration; existing native path
  remains unchanged
- Completion rule: sanitized Anthropic Messages fixtures와 fake upstream에서
  thinking/tool/structured worker report가 완료됨

### SLICE-003 — Google and Responses-compatible builtins

- Status: APPROVED
- Objective: OBJ-003, OBJ-004
- Includes: Google and Responses portions of REQ-008, REQ-009, REQ-010,
  REQ-011, REQ-013, REQ-015
- Acceptance: AC-008, AC-009, AC-010, AC-011, AC-013, AC-015
- Verification: TEST-008, TEST-009, TEST-010, TEST-011, TEST-013, TEST-015
- Dependencies: SLICE-001
- Excludes: provider-specific OAuth
- External contracts affected: builtin adapter registry and provider catalog
- Rollback/recovery: remove affected builtin registration
- Completion rule: deterministic Google/Responses fixtures와 fake upstream
  integration이 통과함

### SLICE-004 — Trusted custom adapter V1

- Status: APPROVED
- Objective: OBJ-003, OBJ-004
- Includes: REQ-002, REQ-009, REQ-010, REQ-011, REQ-015
- Acceptance: AC-002, AC-009, AC-010, AC-011, AC-015
- Verification: TEST-002, TEST-009, TEST-010, TEST-011, TEST-015
- Dependencies: SLICE-001
- Excludes: sandbox claim, hot reload, project-local automatic loading
- External contracts affected: provider catalog `[adapters]` and
  `ProviderAdapterV1`
- Rollback/recovery: unregister custom adapter/provider; preserve failed run
  diagnostics without executing changed bytes
- Completion rule: valid hash-pinned custom adapter가 worker를 완료하고 모든
  negative loader/capability/redaction test가 통과함

### SLICE-005 — Z.AI Coding Plan live activation

- Status: NOT_READY
- Objective: OBJ-002
- Includes: REQ-014 plus applicable approved external worker requirements
- Acceptance: AC-014 plus provider live smoke criteria
- Verification: TEST-014 plus explicitly authorized live smoke
- Dependencies: SLICE-001, provider confirmation or separate written agreement
- Excludes: unsupported subscription quota use
- External contracts affected: policy metadata in provider catalog
- Rollback/recovery: keep offline adapter support; block live request
- Completion rule: policy blocker가 해소되고 사용자가 credential-consuming smoke를
  별도로 승인한 뒤에만 정의 가능

### SLICE-006 — Claude account OAuth

- Status: NOT_READY
- Objective: OBJ-003
- Includes: none approved
- Acceptance: none approved
- Verification: none approved
- Dependencies: Q-001 resolution, credential store/refresh/security contract
- Excludes: API-key path, which is SLICE-002
- External contracts affected: future auth lifecycle
- Rollback/recovery: API-key provider remains available
- Completion rule: 별도 spec delta 승인 필요

## 18. Traceability

| Objective | Requirement | Acceptance | Verification | Slice |
| --- | --- | --- | --- | --- |
| OBJ-001 | REQ-001 | AC-001 | TEST-001 | SLICE-001 |
| OBJ-003 | REQ-002 | AC-002 | TEST-002 | SLICE-004 |
| OBJ-002 | REQ-003 | AC-003 | TEST-003 | SLICE-001 |
| OBJ-004 | REQ-004 | AC-004 | TEST-004 | SLICE-001 |
| OBJ-001, OBJ-004 | REQ-005 | AC-005 | TEST-005 | SLICE-001 |
| OBJ-001, OBJ-002 | REQ-006 | AC-006 | TEST-006 | SLICE-001 |
| OBJ-002 | REQ-007 | AC-007 | TEST-007 | SLICE-001 |
| OBJ-003 | REQ-008 | AC-008 | TEST-008 | SLICE-001, SLICE-002, SLICE-003 |
| OBJ-003, OBJ-004 | REQ-009 | AC-009 | TEST-009 | SLICE-001, SLICE-002, SLICE-003, SLICE-004 |
| OBJ-004 | REQ-010 | AC-010 | TEST-010 | SLICE-001, SLICE-002, SLICE-003, SLICE-004 |
| OBJ-004 | REQ-011 | AC-011 | TEST-011 | SLICE-001, SLICE-002, SLICE-003, SLICE-004 |
| OBJ-001, OBJ-002 | REQ-012 | AC-012 | TEST-012 | SLICE-001 |
| OBJ-003 | REQ-013 | AC-013 | TEST-013 | SLICE-002, SLICE-003 |
| OBJ-002, OBJ-004 | REQ-014 | AC-014 | TEST-014 | SLICE-005 |
| OBJ-004 | REQ-015 | AC-015 | TEST-015 | SLICE-001, SLICE-002, SLICE-003, SLICE-004 |

## 19. Decision log

| Decision | 결과 |
| --- | --- |
| `DEC-001` | Provider config는 Ark 전용 absolute TOML |
| `DEC-002` | Project config와 user Codex config는 credential/provider store가 아님 |
| `DEC-003` | External model은 run의 explicit override로만 활성화 |
| `DEC-004` | External app-server state는 Ark state root의 isolated Codex home |
| `DEC-005` | Full OpenCodex/sidecar 대신 in-process bridge |
| `DEC-006` | Bridge는 보안상 loopback-only, port 10001 이상 |
| `DEC-007` | Child에는 bridge token만 전달 |
| `DEC-008` | Binding은 assignment 전에 확정하고 continuation에서 고정 |
| `DEC-009` | Capability/effort downgrade와 fallback 금지 |
| `DEC-010` | Pinned OpenCodex code를 attribution과 함께 최소 port |
| `DEC-011` | Custom adapter는 trusted executable code |
| `DEC-012` | Claude API key 먼저, OAuth는 별도 delta |

## 20. Approval result

- Terminal status: `SPEC_APPROVED_WITH_WARNINGS`
- Approved slices: `SLICE-001`, `SLICE-002`, `SLICE-003`, `SLICE-004`
- Blocked slices: `SLICE-005`, `SLICE-006`
- Warning: Z.AI Coding Plan live activation은 현재 공식 supported-tool 정책에
  의해 승인되지 않았다.
- Warning: custom adapter hash pinning은 code sandbox가 아니다.
- Next action: `SLICE-001`을 `sdd-implementation-loop`으로 구현한다.
