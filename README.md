# 상호에게 — 기상호 × 예지

GitHub + Vercel 채팅 화면과 Cloudflare Worker + D1 기억 서버입니다. `luv3r.me` 연결은 없습니다. 기존 Anthropic API 키를 그대로 사용할 수 있습니다.

운영 사이트: https://sangho-yeji.vercel.app

운영 Worker: https://kisangho-chat.kisangho.workers.dev (새 Cloudflare 계정)

현재 계정에 등록된 API 키는 `Secret`이라는 Secret 이름으로 저장되어 있어 서버가 이 이름도 지원합니다. `ANTHROPIC_API_KEY`가 있으면 해당 값을 우선 사용합니다. 키 값은 코드나 저장소에 포함하지 않습니다.

현재 설정: 예지 26세, 상호 23세. 준향대 휴학 중인 고양 농구팀 선수 상호가 일산 성인 영어학원에 새로 등록해 예지를 처음 만납니다. 처음에는 예지님과 존댓말, 친밀해지면 예지 누나·누님과 반존대, 이후 누나·예지 누나와 반존대로 자연스럽게 발전합니다. 관계와 호칭의 변화도 장기기억에 보존합니다.

## 동작

- **모든 접속자가 하나의 대화와 기억을 공유합니다.** 로그인·기기별 세션을 만들지 않습니다. 주소를 전달하면 상대도 같은 기록을 읽고 대화할 수 있습니다.
- 문자와 장면 모드가 같은 기억을 사용합니다.
- 원문은 D1 `messages`에 만료 없이 저장합니다. 자동 삭제·30일 TTL이 없습니다. Cloudflare 계정/DB를 삭제하거나 서비스 한도를 넘는 경우까지 보관을 보장하지는 않습니다.
- 오래된 대화는 누적 기억으로 정리하고, 아직 정리하지 않은 원문과 함께 AI에게 보냅니다. 기억 수정본도 보관합니다. **원문 보관과 AI의 완벽한 회상은 다릅니다.** 요약에서 세부 내용이 누락되거나 AI가 잘못 답할 수 있습니다.
- 실패한 답변은 대화 쌍을 저장하지 않습니다. 입력은 브라우저 임시 초안으로 남습니다. 재전송은 같은 요청 ID를 써서 중복을 방지합니다.
- 공유 잠금으로 두 기기의 동시 전송을 막습니다. 다른 기기에서 보낸 대화는 창으로 돌아오거나 새로고침하면 불러옵니다.
- 기록 보관 버튼은 전체 대화 원문과 현재 누적 기억을 JSON으로 내려받습니다. 복원 UI는 아직 없습니다.
- 하루 기본 200회의 생성 시도를 허용합니다(한국 시간 자정 갱신). 실패한 시도도 포함합니다. 한 시도에 답변 생성과 기억 요약 호출이 있을 수 있으므로 토큰·금액 한도는 아닙니다.
- UI에는 삭제나 초기화 버튼이 없습니다.

## 구성

```text
Vercel: public/ + api/[action].js
  │ 서버 전용 공유 비밀값으로 연결
  ▼
Cloudflare Worker: worker/src/index.js
  ├─ D1: 원문, 누적 기억, 기억 수정본, 일일 횟수
  └─ Anthropic API (선택적으로 기존 Cloudflare AI Gateway 경유)
```

기존 KV 대신 D1을 사용합니다. 모든 기록을 하나의 KV 값으로 덮어쓰지 않고 메시지별로 저장하고, 동시에 요청해도 기록이 유실되지 않도록 하기 위한 선택입니다. 기존 `seowoo-chat`과 기존 KV는 수정하지 않습니다.

## 1. 설치

Node.js 22 이상과 npm이 필요합니다. 테스트는 `node:sqlite`가 있는 Node 22.13 이상 또는 Node 24를 권장합니다.

```powershell
npm install
npm run check
npm test
npm run cf -- login
```

## 2. Cloudflare D1 만들기

이 저장소에는 현재 계정에 생성한 `kisangho-memory` DB ID가 연결되어 있습니다. **같은 계정에서 이어서 배포할 때는 DB를 다시 만들지 않고** `npm run db:remote`부터 실행합니다. 아래 생성 명령은 다른 계정으로 새로 설치할 때만 사용합니다.

```powershell
npm run cf -- d1 create kisangho-memory
```

출력된 `database_id`를 `worker/wrangler.jsonc`의 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 자리에 넣습니다. D1 바인딩 이름은 `DB`입니다.

```powershell
npm run db:remote
```

이 단계는 **새 DB**에 테이블을 만듭니다. 기존 서우 저장소에 연결하지 마세요.

## 3. Worker 비밀값 설정과 배포

기존 Anthropic 키는 다음 명령의 입력창에 붙여 넣습니다. 코드·GitHub·메신저에 넣지 않습니다.

```powershell
npm run cf -- secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
npm run cf -- secret put WORKER_SHARED_SECRET --config worker/wrangler.jsonc
```

`WORKER_SHARED_SECRET`은 새 무작위 비밀값으로 정하고, 잠시 후 Vercel에도 **똑같은 값**을 넣습니다. API 키와 다른 값입니다. 예를 들어 비밀번호 관리자로 40자 이상의 무작위 문자열을 만들면 됩니다.

이 컴퓨터에서는 기존 계정과 새 계정의 CLI 인증을 분리해 두었습니다. `npm run cf` 및 배포·DB 명령은 Git에서 제외한 `.env.cloudflare.local`을 통해 새 계정의 인증 폴더를 선택합니다. 다른 컴퓨터에는 이 파일을 복사할 필요 없이 새 계정으로 로그인하면 됩니다.

모델은 기존 코드와 같은 `claude-opus-4-6`으로 설정했습니다. 실제 API 계정의 사용 가능 모델에 맞춰 `worker/wrangler.jsonc`의 `ANTHROPIC_MODEL`, `MEMORY_MODEL`을 변경할 수 있습니다. 기억 정리에도 별도 API 비용이 발생합니다.

기존 AI Gateway를 계속 경유하려면 Cloudflare Worker 설정에 `CF_ACCOUNT_ID`, `GATEWAY_ID`를 추가합니다. 둘 다 없으면 Anthropic API에 직접 연결합니다. Gateway가 별도 인증을 요구하는 구성이라면 해당 인증 처리를 추가해야 합니다.

```powershell
npm run worker:deploy
```

출력된 `https://kisangho-chat.….workers.dev` 주소를 기록합니다. Worker 주소를 브라우저에서 직접 열면 인증 오류가 나는 것이 정상입니다. 화면은 Vercel 주소에서 엽니다.

## 4. GitHub → Vercel

1. 이 파일들을 `PMC314159/kisangho` 저장소 루트에 올립니다.
2. Vercel에서 **Add New → Project → kisangho Import**를 선택합니다.
3. Framework Preset은 **Other**, Root Directory는 저장소 루트(`./`)로 둡니다. 설정 파일이 출력 폴더 `public`을 지정합니다. 별도 빌드 명령은 없습니다.
4. Environment Variables에 다음 두 값을 추가합니다.

| Vercel 환경변수 | 값 |
| --- | --- |
| `CHAT_WORKER_URL` | 위에서 배포한 Worker의 https 주소 |
| `WORKER_SHARED_SECRET` | Cloudflare에 넣은 것과 동일한 무작위 비밀값 |

5. Deploy를 누릅니다. 환경변수를 나중에 수정했다면 Redeploy합니다.
6. 사이트에서 한 번 대화한 뒤 새로고침·다른 기기로 접속해 같은 기록이 나오는지 확인합니다.

**Anthropic API 키는 Vercel이나 화면 파일에 넣지 않고 Cloudflare Secret에만 넣습니다.** Worker 공유 비밀값도 Vercel 서버에서만 사용하며 브라우저로 보내지 않습니다. Vercel 사이트는 링크로 누구나 사용할 수 있으므로 주소를 아는 사람도 AI 호출 비용을 발생시킬 수 있습니다.

## 로컬 미리보기

화면만 보기:

```powershell
npm run dev
```

`http://127.0.0.1:3000`에서 볼 수 있습니다. 연결 설정 전에는 실제 답변 대신 서버 설정 안내가 표시됩니다. 가짜 AI 응답을 만들지 않습니다.

로컬에서도 실제 API와 저장을 쓰려면:

1. `.env.example`을 `.env.local`로 복사하고 `CHAT_WORKER_URL=http://127.0.0.1:8787` 및 공유 비밀값을 설정합니다.
2. `worker/.dev.vars.example`을 `worker/.dev.vars`로 복사해 실제 API 키와 동일한 공유 비밀값을 입력합니다.
3. `npm run db:local` 실행 후 별도 터미널에서 `npm run worker:dev`를 실행합니다.
4. `npm run dev`를 실행합니다.

로컬 D1과 운영 D1은 별개입니다. 운영 배포 전에는 반드시 `npm run db:remote`도 실행하세요.

## 설정을 수정할 곳

| 목적 | 파일 |
| --- | --- |
| 캐릭터·관계·사투리·대화 길이 | `worker/src/character.js` |
| AI 호출·기억·대화 저장 | `worker/src/index.js` |
| 모델·일일 횟수·D1 연결 | `worker/wrangler.jsonc` |
| 화면 | `public/index.html`, `public/style.css`, `public/app.js` |
| Vercel 서버 연결 | `api/[action].js` |

화면 변경은 GitHub → Vercel 배포로 반영합니다. 캐릭터와 서버 코드를 변경했다면 `npm run worker:deploy`도 실행해야 합니다. Worker 코드 배포는 기존 D1 대화를 초기화하지 않습니다.

## 확인 범위

자동 테스트는 SQLite를 사용해 실제 SQL, 모드 간 기억 공유, 중복 방지, 동시 요청 잠금, API 실패 복구, 기억 요약 성공/실패, 이전 대화 페이지와 전체 내보내기를 확인합니다. 실제 Cloudflare·Vercel 배포와 Anthropic 응답은 각 계정 연결 및 비밀값 설정 후 별도로 확인해야 합니다.

공식 참고: [D1 마이그레이션](https://developers.cloudflare.com/d1/reference/migrations/), [D1 API](https://developers.cloudflare.com/d1/worker-api/), [Vercel Node.js 함수](https://vercel.com/docs/functions/runtimes/node-js), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create).
