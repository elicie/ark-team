# Ark Team QA smoke fixture

이 예제는 Ark Team의 production Backend/UI verification runtime을 실제
로컬 서버에 연결하는 회귀 테스트 입력입니다.

- 서버는 `HOST=0.0.0.0`, `PORT=10001` 이상만 허용합니다.
- 요청 Host는 `devbox:<port>`여야 합니다.
- `/health`는 Backend curl probe, `/`는 deterministic Playwright case에
  사용됩니다.
- 테스트 harness만 임시 Git 저장소와 test-only 승인 baseline을 만듭니다.
  제품용 baseline 생성·승인 기능은 제공하지 않습니다.

저장소 루트에서 실행합니다.

```sh
npm run test:qa-smoke
```
