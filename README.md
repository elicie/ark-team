# Ark Team

`ark-team`은 PM이 명시적으로 주도하는 다중 팀 작업을 위한 저장소 범위의 Codex 스킬이자 플러그인 소스입니다.

이 스킬은 다음과 같이 합의된 운영 계약을 구현합니다.

- 관리만 담당하는 PM
- 동적으로 생성되는 PL 주도 팀
- 격리된 Git worktree
- 단계적인 로컬 통합
- 보호 절차가 적용된 원격 작업
- 관찰 가능한 상태와 보고서
- 재개 가능한 실패 및 취소 처리

## 저장소 구조

```text
.agents/skills/ark-team
  -> ../../plugins/ark-team/skills/ark-team
.codex/agents/
  ark_pm.toml
  ark_pl.toml
  ark_worker.toml
.codex/team-orchestrator.toml
plugins/ark-team/
  .mcp.json
  .codex-plugin/plugin.json
  runtime/
    dist/
      approval-session.js
      server.js
      session-cli.js
    src/
    test/
  skills/ark-team/
    SKILL.md
    agents/openai.yaml
    references/
```

`plugins/ark-team` 아래의 플러그인 사본이 스킬과 런타임의 원본입니다.
이 저장소에서 작업할 때는 `.agents/skills` 링크를 통해 같은 스킬을
탐색할 수 있습니다. 프로젝트 범위의 커스텀 에이전트 정의는
`.codex/agents` 아래에 있습니다.

## 요구 사항

- 스킬과 서브에이전트를 지원하는 Codex 릴리스를 사용합니다.
- 멀티 에이전트 지원을 활성화합니다.
- Backend-only 로컬 MCP 서버는 Node.js 18 이상에서 로드되며, UI QA
  setup과 실행에는 Node.js 20 이상을 사용합니다.
- 작성 팀을 격리하려면 worktree를 지원하는 Git을 설치하거나, 이에 준하는 관리형 런타임 격리 백엔드를 제공합니다.
- 네이티브 폴백은 호스트의 동시 실행 제한을 따릅니다.
- 네이티브 커스텀 에이전트는 PM을 Sol/xhigh, PL을 Terra/xhigh, worker를
  Luna/xhigh로 고정합니다.
- 관리형 역할 백엔드는 로컬 stdio를 통해 `codex app-server`를 사용하며,
  `PATH`에 인증된 `codex` 실행 파일과 호환되는 자동 생성 stable protocol
  스키마가 필요합니다.
- Pull Request 모드는 `github.com` 원격 저장소를 지원하며, 인증된
  GitHub CLI(`gh`)가 `PATH`에 있어야 합니다. 경로를 재정의하려면
  `ARK_TEAM_GH_PATH`를 설정합니다.
- MCP 제어 평면은 실행 및 할당 상태를 영속화하고, 관리형
  PM → PL → worker 계층을 예약하며, PM 계획을 연결된 팀 worktree로
  구체화하고, 검증된 worker 보고서를 사용해 각 PL을 재개할 수 있습니다.

## 런타임 제어 평면

플러그인은 로컬 stdio MCP 서버를 포함하며 `.mcp.json`을 통해 등록합니다.
현재 제공하는 도구는 다음과 같습니다.

- `ark_team_start`
- `ark_team_execute`
- `ark_team_advance`
- `ark_team_list`
- `ark_team_status`
- `ark_team_logs`
- `ark_team_pause`
- `ark_team_resume`
- `ark_team_cancel`
- `ark_team_plan_apply`
- `ark_team_remote_decide`
- `ark_team_team_list`
- `ark_team_assignment_start`
- `ark_team_assignment_list`
- `ark_team_assignment_status`
- `ark_team_assignment_decide`
- `ark_team_assignment_recover`
- `ark_team_assignment_retry_decide`
- `ark_team_assignment_cancel`

실행 정보는 기본적으로 `~/.ark-team/runs` 아래에 원자적
JSON 레코드로 저장됩니다. 다른 위치를 사용하려면 Codex를 시작하기 전에
절대 경로인 `ARK_TEAM_STATE_ROOT` 환경 변수를 설정합니다.

## 외부 worker provider 사용법

Ark Team은 worker만 외부 OpenAI Chat 호환 provider로 명시적으로 교체할
수 있습니다. PM과 PL은 기존 Codex 모델을 사용합니다. 외부 provider를
선택하지 않으면 worker도 기존 Luna/xhigh를 그대로 사용합니다.

### 1. Provider catalog 준비

Provider 설정은 프로젝트 저장소가 아니라 사용자 소유의
`~/.ark-team/catalogs/providers-v1.toml`에 두는 것을 권장합니다.
`inline_key`를 사용하면 API key가 평문으로 저장되므로 catalog 디렉터리는
`0700`, 파일은 `0600` 권한이어야 합니다.

```sh
mkdir -p ~/.ark-team/catalogs
chmod 700 ~/.ark-team ~/.ark-team/catalogs
```

아래 내용을 `~/.ark-team/catalogs/providers-v1.toml`에 저장한 뒤 파일
권한을 설정합니다.

```sh
chmod 600 ~/.ark-team/catalogs/providers-v1.toml
```

이 파일은 Git, 동기화 디렉터리, 공개 백업에 포함하지 마십시오.

Z.AI GLM Coding Plan에서 `glm-5.2`를 사용하는 `inline_key` 예시는 다음과
같습니다.

```toml
version = 1

[providers.zai_open_platform]
adapter = "builtin:openai-chat"
base_url = "https://api.z.ai/api/coding/paas/v4/"
auth_kind = "inline_key"
api_key = "여기에-Z.AI-API-key-입력"
structured_output_mode = "validated_json"
policy = "standard"
allowed_models = ["glm-5.2"]

[providers.zai_open_platform.reasoning_effort_map]
xhigh = "max"
```

`policy = "standard"`는 실제 호출을 허용합니다. `policy = "blocked"`이면
API key와 endpoint가 올바르더라도 네트워크 요청 전에
`PROVIDER_POLICY_BLOCKED`로 중단합니다.

API key를 catalog에 직접 넣지 않으려면 같은 provider에서 다음 두 줄을
사용합니다.

```toml
auth_kind = "env_key"
api_key_env = "ZAI_API_KEY"
```

이 경우 Codex를 시작하기 전에 환경 변수를 설정합니다.

```sh
export ZAI_API_KEY="여기에-Z.AI-API-key-입력"
```

하나의 catalog에 여러 `[providers.<provider-id>]` 항목을 함께 둘 수
있습니다. 실행할 때 지정한 provider만 선택되며, 다른 provider 설정을
모두 채울 필요는 없습니다. 현재 구현된 adapter는
`builtin:openai-chat`입니다.

### 2. Codex에 catalog 경로 전달

Codex를 시작하기 전에 catalog의 절대 경로를 설정합니다.

```sh
export ARK_TEAM_PROVIDER_CONFIG="$HOME/.ark-team/catalogs/providers-v1.toml"
```

설치된 plugin manifest는 `ARK_TEAM_PROVIDER_CONFIG`와 `ZAI_API_KEY`를 MCP
서버에 전달합니다. 다른 이름의 `api_key_env`를 사용한다면
`plugins/ark-team/.mcp.json`의 `env_vars`에도 그 이름을 추가해야 합니다.
환경 변수를 변경하거나 plugin을 업데이트한 뒤에는 새 Codex 세션을
시작합니다.

### 3. 외부 worker로 실행

일반적인 전체 실행에는 `ark_team_execute`를 사용합니다. 입력의
`model_overrides.worker`에 catalog의 provider ID, 실제 model ID, 요청할
reasoning effort를 지정합니다.

```json
{
  "objective": "요청한 기능을 구현하고 검증한다",
  "project_path": "/absolute/path/to/project",
  "model_overrides": {
    "worker": {
      "provider": "zai_open_platform",
      "model": "glm-5.2",
      "reasoning_effort": "xhigh"
    }
  }
}
```

수동으로 계획을 적용하거나 복구 흐름을 제어할 때는 같은
`model_overrides`를 `ark_team_start`에 전달합니다. 기존 실행 도중
provider를 바꾸지는 않으며, 선택 결과는 run과 worker assignment에
영속화됩니다.

Codex 대화에서는 다음처럼 요청할 수 있습니다.

```text
$ark-team 이 프로젝트에서 요청한 작업을 실행해줘.
worker는 provider zai_open_platform, model glm-5.2,
reasoning_effort xhigh를 사용해.
```

### 4. 선택 결과 확인

`ark_team_status` 또는 `ark_team_assignment_status`에서 다음 항목을
확인합니다.

```json
{
  "kind": "external",
  "provider_id": "zai_open_platform",
  "model": "glm-5.2",
  "requested_reasoning_effort": "xhigh",
  "effective_reasoning_effort": "max"
}
```

API key 자체는 상태, 로그, binding, argv 또는 app-server child 환경에
저장되지 않습니다. 외부 worker는 인증된 `127.0.0.1` loopback bridge와
run별 격리된 `CODEX_HOME`을 사용합니다. 실패하면 같은 provider binding으로
최대 세 번 재시도하며 Luna로 자동 전환하지 않습니다.

`inline_key`의 key 값만 교체하면 다음 요청부터 새 값을 읽습니다. 반면
endpoint, 인증 방식, model mapping 같은 비밀이 아닌 설정을 실행 도중
바꾸면 기존 binding과 달라지므로 해당 실행은 drift로 중단됩니다.

자세한 catalog schema와 오류 조건은
`plugins/ark-team/skills/ark-team/references/configuration.md`를 참고합니다.

런타임은 실행을 생성할 때 선택한 프로젝트의
`.codex/team-orchestrator.toml`을 엄격하게 불러오고, 문서화된 기본값을
적용한 뒤, 완전히 해석된 스냅샷을 실행 정보에 저장합니다. 프로젝트별
재정의로 팀과 worker 수를 줄이거나, 관리형 세션·재시도·수정 제한을
조정하거나, 안전한 통합 브랜치 접두사를 설정하거나, 리터럴 검증 명령을
추가할 수 있습니다. 고정된 Sol/Terra/Luna `xhigh` 역할, PM/작성자 권한,
원격 승인, 브랜치 보존, 사용량 전용 로깅, 비공개 추론 제외 정책은
완화할 수 없습니다. 알 수 없는 키, 자격 증명, 안전하지 않은 경로,
잘못된 값이 있으면 실행을 생성하기 전에 실패합니다. 이후 TOML을
수정해도 기존 실행에는 영향을 주지 않습니다.

`ark_team_plan_apply`는 검증된 `pm_plan` 하나를 받습니다. 깨끗한 Git
저장소 루트에서 같은 기준 커밋으로부터 팀마다 하나의 연결된 worktree와
`ark-team/<run-id>/<team-id>` 브랜치를 만든 다음, 계획과 팀 레코드를
원자적으로 저장합니다. `ark_team_team_list`는 각 팀의 임무, 의존성,
브랜치, worktree, 기준 커밋, worker 수, 상태를 반환합니다. 기본
`<state-root>/.worktrees` 위치를 재정의하려면 `ARK_TEAM_WORKTREE_ROOT`를
절대 경로나 `~/...`로 설정합니다. 해석된 위치는 프로젝트 checkout
외부에 있어야 합니다.

`ark_team_execute`는 실행 생성, Sol/xhigh 읽기 전용 PM 턴, 엄격한 계획
검증, PM 세션/사용량 영속화, 계획 적용을 하나로 결합합니다. PM 실패는
영속적인 실패 상태의 실행을 남깁니다. 이후 worktree 생성에 실패하면
검증된 PM 계획이 계획 단계의 실행에 남으므로, PM 턴을 다시 소비하지
않고 `ark_team_plan_apply`로 재시도할 수 있습니다.

계획을 구체화한 뒤 코디네이터는 서로 독립적인 Terra PL을 병렬로
시작하고, 정확한 worker 수를 검증하며, 의존성이 충족된 Luna worker를
여러 차례에 걸쳐 실행한 다음, 취합된 worker 보고서를 전달해 각 원래
PL 세션을 재개합니다. `ark_team_advance`는 승인 결정 후 이 과정을
이어갑니다. 모든 PL 보고서가 각 worker를 포함하고 검증을 통과하면
실행은 `integrating` 상태로 진입합니다. 이후 최상위 코디네이터는 별도의
연결된 worktree에 `orchestrator/<run-id>`를 만들고 Terra/xhigh 통합 PL을
배정합니다. 통합 PL은 모든 팀 브랜치 tip을 포함하는 깨끗한 보고 커밋을
독립적으로 검증합니다.

`local_merge`의 경우, 런타임은 원래 브랜치와 HEAD 및 작업 디렉터리의
청결 상태가 기록된 시작 경계와 여전히 일치할 때만 원래 브랜치를
fast-forward합니다. 그런 다음 원래의 Sol/xhigh 읽기 전용 PM 세션을
재개하여 엄격한 최종 `pm_report`를 받습니다. `pull_request`의 경우에는
먼저 로컬 GitHub 원격 저장소와 CLI 인증을 읽기 전용으로 검증한 뒤,
정확한 원격 저장소, 브랜치, 대상, 커밋 튜플을 담은 불투명 요청 하나와
함께 `remote_action_required`를 반환합니다. 현재 요청 ID와 사용자의
명시적인 `approve_once`를 받은 `ark_team_remote_decide`만 해당 커밋을
push하고 PR을 생성하거나 기존 PR을 채택할 수 있습니다. `cancel_run`은
모든 로컬 산출물을 보존합니다. 해당 실행을 명시적으로 재개하면 취소된
승인을 재사용하지 않고 새 요청을 생성합니다. 승인된 실행은 재시작
사이에서도 멱등성을 유지하며, 최대 세 번 시도한 뒤에는 새 승인이
필요합니다.

로컬 fast-forward 또는 승인된 PR이 성공하면 원래 PM 세션이 최종 읽기
전용 인수 검사를 수행합니다. 이후 런타임은 승인된 통합에 브랜치가
포함되어 있고 깨끗한 상태인, 등록된 팀 및 통합 worktree만 제거합니다.
모든 로컬 팀 및 통합 브랜치는 보존되고 검사됩니다. 정리가 끝난
뒤에만 실행 상태가 `completed`가 됩니다. 일부만 정리된 경우에도
재개 작업은 멱등성을 유지합니다.

내부 PL/worker 세션 실패는 최대 두 번까지 새로운 세션으로 자동
재시도합니다. 유효하지만 미흡한 계획과 보고서는 같은 세션에서 최대
두 번까지 수정을 요청합니다. 할당 레코드는 시도 및 수정 횟수를
보관합니다. 제한을 모두 소진하면 별도의 불투명 `pending_retry`가
생성됩니다. `ark_team_assignment_retry_decide`는 명시적인 `retry_once`
또는 `cancel_run`만 받으며, 오래되었거나 재사용된 요청 ID는 안전하게
거부합니다.

관리형 할당 레코드는 동일한 원자적 실행 레코드에 저장됩니다. 각
레코드는 팀과 상위 PL, 연결된 worktree, 상태, 세션 및 턴 ID, 작업 키와
출력 계약, 대기 중인 승인 또는 재시도 요청 하나, 전달된 구조화 보고서,
시도/수정/턴 횟수, 토큰 사용량을 보관합니다. 로그에는 원시 모델 추론이나
이벤트 이력이 아니라 관찰 가능한 상태 변경, 승인 출처(`user` 또는
`routine_policy`), 사용량이 기록됩니다.

스케줄러는 팀마다 PL 한 명, 실행마다 최대 4개 팀, PL마다 최대 5명의
worker를 강제합니다. Worker는 동일한 팀 worktree를 사용하고 자신을
담당하는 PL 할당을 식별합니다. 중간 PL 계획은 컨트롤러로 전달되고,
완료된 worker 보고서는 담당 PL로 전달되며, 같은 PL 세션의 최종
보고서는 PM으로 전달됩니다.

승인 대기 중 MCP 프로세스가 재시작되면 레코드는 계속 표시되지만 기존
app-server 요청 채널은 사라집니다. 해당 실행, 할당, 승인 ID를 정확히
지정해 `ark_team_assignment_recover`를 사용합니다. `resume_safely`는
영속화된 Codex 스레드를 새 턴에서 재개하며, 이전 승인이 적용되지 않은
것으로 명시적으로 처리합니다. 작업이 여전히 필요하다면 에이전트가
새 승인 ID를 제시해야 합니다. `cancel_run`은 worktree, 브랜치, 커밋,
보고서, 로그를 보존하면서 실행을 중단합니다. 일반적인
`ark_team_assignment_decide`는 원래 라이브 세션이 존재하는 동안에만
유효하며, 오래되었거나 재사용된 복구 요청은 안전하게 거부합니다.

저장소 루트에서 번들 서버를 빌드하고 검증합니다.

```sh
npm install
npm test
```

`npm test`는 소스의 타입을 검사하고, 영속성·스케줄러·승인 게이트웨이
테스트를 실행하며, MCP 서버·관리형 세션 CLI·승인 세션 라이브러리를
빌드하고, CLI와 MCP 진입점을 검사합니다.

## 관리형 역할 세션

관리형 런처는 명시적인 모델, 추론, 샌드박스, 승인 설정으로 각 역할을
별도의 Codex 스레드에서 시작합니다. 스레드 ID, 최종 역할 보고서,
구성 메타데이터, 토큰 사용량만 반환하며, 원시 추론과 이벤트 항목은
반환하지 않습니다.

컨트롤러 코드는 기계 판독이 필요한 턴에 엄격한 `output_contract`를
선택할 수 있습니다.

- PM에는 `pm_plan`과 `pm_report`
- PL에는 `pl_worker_plan`, `pl_report`, `integration_report`
- worker에는 `worker_report`

구조화 호출은 일치하는 JSON Schema를 Codex에 전달하고, 두 번째 엄격한
런타임 검증을 거친 뒤에만 파싱된 `structured_report`를 반환합니다.
계획에 알 수 없는 필드나 4개를 초과하는 팀, 5명을 초과하는 worker,
중복 ID, 알 수 없는 의존성, 의존성 순환이 있으면 거부됩니다.

완료된 역할 스레드를 이어가려면 이전 `session_id`를
`resume_session_id`로 전달합니다. 모든 역할은 app-server의
`thread/resume`을 사용하고 정확한 관리형 역할 프로필을 다시 적용하며,
다른 스레드 ID는 거부합니다. 작성자 경로는 새 턴을 시작하기 전에
worktree cwd, workspace-write 루트, 비활성화된 네트워크, 사용자 승인
라우팅, 모델, xhigh effort도 다시 검사합니다.

읽기 전용 PM 세션을 실행합니다.

```sh
node plugins/ark-team/runtime/dist/session-cli.js \
  --role pm \
  --cwd /absolute/path/to/project \
  --assignment "Inspect the project and return a bounded team plan."
```

PL과 worker 세션은 연결된 Git worktree의 루트만 받습니다. 런처는 기본
checkout과 유효한 `.git` 포인터 파일이 없는 디렉터리를 거부합니다.

```sh
node plugins/ark-team/runtime/dist/session-cli.js \
  --role worker \
  --cwd /absolute/path/to/linked-worktree \
  --assignment-file /absolute/path/to/assignment.txt
```

`codex`가 기본 경로가 아닌 곳에 설치되어 있다면
`ARK_TEAM_CODEX_PATH`를 사용합니다. 선택적 라이브 검증은 폐기 가능한
임시 저장소에서 실제 Sol 및 Luna 세션을 시작하므로 모델 사용량이
발생합니다.

```sh
npm run verify:managed-sessions
```

관리형 런처는 모든 역할을 `codex app-server`로 실행합니다. PM은
`read-only`/`never`, 작성자는 `workspace-write`/`on-request`가 실제
스레드 응답에 유지되는지 검증합니다. 비대화형 CLI에서 작성자 승인이
발생하면 우회하지 않고 실패하며, 대화형 할당은 영속적인 할당
스케줄러를 통해 처리해야 합니다.

저수준 역할 세션에는
`plugins/ark-team/runtime/dist/approval-session.js`에서
`AppServerApprovalSession`을 가져와 사용합니다. 이 세션은 stdio를 통해
`codex app-server`를 시작하고 선택한 역할 프로필을 검증합니다. PM은
완료 결과만 반환하며, PL 및 worker는 다음 중 하나를 반환합니다.

- 하나의 불투명 명령, 파일 변경 또는 권한 승인과 함께 `waiting_user`
- 최종 역할 보고서 및 토큰 사용량과 함께 `completed`

저수준 세션은 요청을 자동 승인하지 않습니다. 영속적인 할당 스케줄러는
등록된 할당 worktree 안에서 실행되는 다음의 정확한 명령에만
`approve_once`를 발행할 수 있습니다. `npm ci`, 범위가 제한된 npm test
명령, 기록된 팀 소유 경로의 staging, 부작용이 없는 메시지를 사용한
로컬 commit, 기록된 팀 브랜치의 통합 merge입니다. 개별적으로 유효한
일상 명령은 최대 4개까지 정확한 ` && ` 구분자로 연결할 수 있습니다.
Push, reset, clean, deploy, 권한, 파일 변경, 그 밖의 모든 셸 조합과
일치하지 않는 모든 요청은 여전히 `decide()`를 통한 명시적인 사용자
결정이 필요합니다. 객체는 같은 스레드와 턴에서 대기를 계속합니다.
PM은 read-only로 제한하고, 연결된 Git worktree 루트가 아닌 작성자
디렉터리는 거부합니다. 컨트롤러 프로세스가 종료된 뒤에는 대기 중인
승인을 영속화하지 않습니다.

모델 사용량 없이 프로토콜 호환성을 검사합니다.

```sh
npm run verify:app-server-schema
```

선택적 라이브 검증에는 Luna 사용량이 발생합니다. 폐기 가능한 저장소를
만들고, worktree 외부 명령 승인 하나를 제시한 뒤 거부하며, 파일이
생성되지 않았는지 확인하고 fixture를 제거합니다.

```sh
npm run verify:approval-gateway
```

## 이 저장소에서 사용하기

스킬을 명시적으로 호출합니다.

```text
$ark-team implement this feature
```

이 스킬은 일반적인 단일 에이전트 요청에는 의도적으로 작동하지 않습니다.
프로젝트 커스텀 에이전트 파일을 추가하거나 변경한 뒤에는 정의를 다시
불러올 수 있도록 새 Codex 대화를 시작합니다.

## 이 저장소에서 전역 설치하기

이 저장소는 Codex 플러그인 마켓플레이스이기도 합니다. 소스를 한 번
설치한 다음 플러그인을 설치합니다.

```sh
codex plugin marketplace add elicie/ark-team --ref main
codex plugin add ark-team@ark-team-marketplace --json
```

Codex Plugin 설치는 npm lifecycle을 실행하지 않습니다. 위 JSON 출력의
`installedPath`에 고정된 Playwright와 Chromium을 준비하고 설치본 smoke
검증을 실행합니다.

```sh
ARK_TEAM_INSTALLED_PLUGIN_ROOT="<installedPath>" \
  node plugins/ark-team/runtime/scripts/setup-installed-plugin.mjs
```

위 명령은 저장소 루트의 검증된 소스 스크립트로 실행합니다. 설치본이 현재
소스와 정확히 같은지 먼저 비교한 뒤에만 의존성을 준비하고 검증 성공을
보고합니다.

전역으로 설치되고 활성화된 플러그인을 확인합니다.

```sh
codex plugin list --available --json
```

업데이트를 배포한 뒤에는 마켓플레이스를 새로 고치고, 현재 CLI가
안내하는 Codex 플러그인 명령으로 플러그인을 다시 설치하거나
업데이트한 다음 새 `installedPath`에서 setup 검증을 다시 실행합니다.
스킬과 MCP 서버를 다시 불러올 수 있도록 새 Codex 세션을 시작합니다.
전역 설치는 런타임과 `$ark-team`을 제공하며, 각 대상 프로젝트는
`.codex/team-orchestrator.toml`을 통해 자체적인 안전한 재정의를 계속
관리합니다.

## 다른 저장소에서 참조하기

원본 스킬을 가리키는 프로젝트 범위의 심볼릭 링크를 생성합니다.

```sh
mkdir -p /absolute/path/to/other-project/.agents/skills
ln -s /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  /absolute/path/to/other-project/.agents/skills/ark-team
```

링크가 명확하도록 절대 경로를 사용합니다. 기존 `ark-team` 디렉터리나
링크를 덮어쓰지 마십시오.

대상 저장소에서 고정된 네이티브 PM/PL/worker 역할을 사용해야 한다면
프로젝트 커스텀 에이전트를 복사합니다.

```sh
mkdir -p /absolute/path/to/other-project/.codex/agents
cp .codex/agents/ark_*.toml \
  /absolute/path/to/other-project/.codex/agents/
```

모든 로컬 프로젝트에서 스킬을 사용하려면 사용자 스킬 디렉터리에
링크합니다.

```sh
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  ~/.agents/skills/ark-team
```

심볼릭 링크를 사용할 수 없거나 원하지 않는 경우에는 스킬을 복사합니다.

```sh
cp -R /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  /absolute/path/to/other-project/.agents/skills/ark-team
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\path\to\other-project\.agents\skills
Copy-Item -Recurse C:\path\to\arc\plugins\ark-team\skills\ark-team `
  C:\path\to\other-project\.agents\skills\ark-team
New-Item -ItemType Directory -Force C:\path\to\other-project\.codex\agents
Copy-Item C:\path\to\arc\.codex\agents\ark_*.toml `
  C:\path\to\other-project\.codex\agents
```

복사한 스킬에는 이 저장소의 업데이트가 반영되지 않습니다. 링크를
사용하거나 소스가 변경된 뒤 다시 복사하십시오.

이 소스를 공유하는 대신 별도로 커스텀한 스킬을 만들려면 Codex에
다음과 같이 요청합니다.

```text
Use $skill-creator. Read /absolute/path/to/arc/plugins/ark-team/skills/ark-team/SKILL.md
and its references, then create a project-specific variant without modifying the source.
```

공개 배포 전에는 검토된 커밋이나 태그를 배포하고, 명시적인 라이선스와
지속적으로 유효한 배포자 메타데이터를 추가합니다.

## 현재 구현 범위

현재 이 저장소는 검증된 스킬 계약, 프로젝트 기본값, 플러그인 패키지,
영속적인 실행 레코드, MCP 수명 주기/상태 도구, 프로젝트 범위 네이티브
커스텀 에이전트, 통합 app-server 역할 런처와 승인 게이트웨이,
명시적으로 정의된 PL 및 worker 할당을 위한 영속적인 MCP
스케줄러를 제공합니다. 이제 역할 세션은 엄격한 계획 및 보고서 JSON
계약을 제공하며, 완료된 PM, PL, worker 스레드를 이어갈 수 있습니다.
제어 평면은 검증된 PM 계획을 영속적인 연결 팀 worktree와 보존되는
로컬 브랜치로 구체화할 수 있고, `ark_team_execute`는 한 번의 MCP
호출로 해당 PM 계획 경로를 구동합니다.

이제 런타임은 서로 독립적인 팀과 worker를 동시에 배정하고, 의존성을
통제하며, 저장된 worker 보고서를 동일 세션의 PL 이어가기로 전달하고,
범위가 제한된 내부 실패 재시도 및 보고서 수정을 적용하며, 영속적인
승인 또는 재시도 선택 상태에서 중단합니다. 또한 별도의 통합 PL을
실행하고, Git 계보와 청결 상태를 검사하며, 보호 절차가 적용된 로컬
fast-forward를 수행한 뒤, 최종 인수를 위해 PM을 재개합니다. 이제
정확한 GitHub push/PR 튜플도 한 번의 명시적인 승인으로 통제하며,
브랜치를 보존한 채 검증된 연결 worktree를 정리합니다. 영속화된 승인
대기는 컨트롤러가 재시작된 뒤 같은 스레드에서 명시적으로 복구할 수
있으며, 사라진 승인을 새 턴으로 넘기지 않습니다. 명시적인 외부
worker provider는 `builtin:openai-chat` adapter와 strict catalog,
loopback bridge를 통해 지원합니다. Anthropic, Google,
OpenAI Responses 및 custom adapter를 실제 실행에 추가하려면 후속
런타임 구현 단위가 필요합니다.

활성화된 Git 연결 worktree/Sol → Terra → Luna 오케스트레이션 목표는
처음부터 끝까지 구현되었으며 전역 설치할 수 있습니다. 결정론적
테스트는 실제 모델 사용량을 소비하지 않고 전체 계층, 승인 및 재시도
중단, 보호된 로컬 및 원격 인계, 정리, 재시작 복구를 검사합니다.
