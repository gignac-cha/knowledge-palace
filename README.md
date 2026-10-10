# Knowledge Palace

출처가 붙은 claim 그래프를 MCP로 AI에 제공하는 서버입니다. 모든 claim은 근거 문서(현재는 IETF RFC)를 인용하고, 모든 추론(inference)은 어떤 claim에서 나왔는지 전제를 명시합니다. 각 노드의 해시에는 전제 노드들의 해시가 들어가서(Merkle DAG), 근거 문서가 바뀌면 그 위에 쌓인 모든 claim이 자동으로 "다시 확인 필요(stale)"로 드러납니다.

## 무엇을 할 수 있나

Claude Code에 연결하고 "HTTP response에서 Referer는 왜 referrer가 아니야?"라고 물으면 Claude는 `resolve` → `get_node`로 claim을 찾아서 이렇게 답합니다 (실제 실행 결과에서 발췌).

> **전제부터 바로잡으면, `Referer`는 HTTP response header가 아니라 request header예요.** RFC 9110은 이 필드를 요청 맥락 필드(Request Context Fields)로 정의합니다. (`http/referer/request-header`, RFC 9110 §10.1.3)
>
> **왜 referrer가 아니라 Referer인가?** 표준에 쓰인 철자가 오타이기 때문입니다. RFC 9110은 이 필드를 `"Referer" [sic]`로 적고 철자가 틀렸다고 밝힙니다. 이 오타는 1996년 HTTP/1.0(RFC 1945 §10.13)에서 이미 같은 철자로 정의됐습니다.
>
> **한 가지 한계:** 스펙은 오타를 왜 고치지 않았는지는 밝히지 않습니다. 지금 그래프에는 그 이유를 뒷받침하는 노드가 없어요.

그래프에 없는 것은 지어내지 않습니다. "Referrer-Policy 헤더는 어떤 RFC에 정의돼 있어?"라고 물으면 해당 노드가 없다고 답합니다.

## 준비

- Node.js v25 이상 (TypeScript를 빌드 없이 `node file.ts`로 직접 실행합니다)
- pnpm

```bash
pnpm install
pnpm run setup   # RFC Editor 인덱스(약 14 MB)를 받아 RFC 9,800여 개를 넣고, data/claims의 claim을 로드
pnpm test
```

데이터베이스는 `data/knowledge-palace.sqlite`에 만들어집니다. 다른 위치를 쓰려면 `KNOWLEDGE_PALACE_DATABASE` 환경 변수를 지정합니다.

## Claude Code에 연결

이 저장소에서 Claude Code를 열면 `.mcp.json`의 `knowledge-palace` 서버를 쓸지 물어봅니다. 다른 프로젝트에서도 쓰려면 사용자 범위로 등록합니다.

```bash
claude mcp add --scope user knowledge-palace -- node /절대/경로/knowledge-palace/sources/server/main.ts
```

## MCP 툴

모든 툴은 읽기 전용입니다.

| 툴 | 하는 일 |
| --- | --- |
| `resolve` | id, 별칭("Referer", "RFC 9110", "멱등"), 제목·본문 단어로 노드 찾기. claim이 문서보다 먼저 나옵니다 |
| `get_node` | 노드의 진술, 상태, 출처 섹션, 검토 상태, 그리고 인용·전제·대체 관계 |
| `derive` | 이 노드가 무엇에 기대는지: 전제와 인용 문서를 재귀적으로 내려가는 트리 |
| `impact` | 이 노드에 기대는 모든 것: 이게 바뀌면 다시 확인해야 할 claim과 추론 |
| `get_history` | 대체 관계(RFC 9110이 RFC 7231을 obsolete)와 갱신 관계 |
| `list_stale` | 검토 후 근거가 바뀌어 다시 확인이 필요한 노드 |

## 데이터 모델

- **노드 종류**: `document`(RFC), `claim`(문서에서 읽은 사실), `inference`(claim에서 유도한 결론)
- **상태**: `established`, `scoped`, `hypothesis`, `refuted`, `superseded`
- **의존 엣지** (해시에 반영): `cites`(claim → 문서), `premise`(추론 → 전제)
- **이력·관계 엣지**: `supersedes`, `updates`, `contests`, `synthesizes`, `alternative`

RFC 문서 노드의 `supersedes`, `updates` 엣지는 [RFC Editor 인덱스](https://www.rfc-editor.org/rfc-index.xml)의 Obsoletes, Updates 관계에서 그대로 가져옵니다. 문서 노드의 내용에는 누가 그 문서를 obsolete하거나 update했는지도 들어가서, 새 RFC가 나오면 해당 문서의 해시가 바뀝니다.

## 재연산과 검토 흐름

1. `pnpm run import:rfc -- --refresh`로 최신 인덱스를 다시 받습니다.
2. 바뀐 RFC를 인용하는 claim과 그 위의 추론은 해시가 바뀌어 stale로 표시됩니다. import가 끝나면 목록이 출력되고, `pnpm run stale`로 다시 볼 수 있습니다.
3. 원문을 다시 확인한 뒤 `node sources/cli.ts verify <id>...`로 검토 완료를 기록합니다. claim 파일을 고쳐서 다시 로드해도 검토한 것으로 기록됩니다.

## claim 추가

`data/claims/*.json`에 노드를 추가하고 `pnpm run load:claims`를 실행합니다. 형식은 [`data/claims/http.json`](data/claims/http.json)을 참고하세요. claim에는 RFC 원문의 섹션을 `sourceURL`, `sourceLocator`로 반드시 붙이고, 원문에 없는 이유나 해석은 쓰지 않습니다.

## 구조

```
sources/
  graph/       노드·엣지 저장소, 해시, resolve/derive/impact/history, 재연산
  importers/   RFC 인덱스 importer, claim 파일 loader
  server/      MCP 서버 (stdio)
  cli.ts       import, load, verify, stale 명령
data/claims/   손으로 검증한 claim 파일
tests/         그래프와 MCP 서버 테스트
```
