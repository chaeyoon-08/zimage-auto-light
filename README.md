# zimage-auto-light

- gcube GPU 클라우드에 **Z-Image-Turbo(uint4)** 를 분산 배포해 이미지를 대량 생성하는 **REST API + 모니터링 웹 UI**
- 여러 레플리카(GPU 노드 위 컨테이너)가 같은 워크로드로 떠서 각자 이미지를 생성하고, 공유 저장소에 결과·상태를 남김
- 웹 UI는 그 공유 저장소를 읽어 전체 레플리카를 한 화면에 집계해 보여줌

## 사용 목적

- gcube에서 GPU 여러 대를 동시에 돌려 **이미지를 분산 생성**(예: 노드 100대 동시 데모)
- 생성 현황·자원·속도를 **웹 대시보드로 모니터링**
- 레플리카별 **일시중지 / 재개 / 취소** 제어

## 구조

```
zimage-auto-light/
├── server.py              # FastAPI 서버 — 생성 워커, 상태 기록, REST API
├── index.html             # 웹 UI (대시보드 + 생성 탭 + 사용설명)
├── static/
│   ├── app.js             # UI 로직 (폴링·렌더링·제어)
│   ├── style.css          # 다크 퍼플 테마
│   └── logo.png
├── conditions.json        # 자동 생성용 프롬프트/파라미터 목록 (100항목)
├── Dockerfile             # CUDA 12.8 + PyTorch cu128 + 모델 베이크
├── entrypoint.sh          # uvicorn 기동
├── requirements.txt
└── .github/workflows/
    └── build.yml          # ghcr 이미지 빌드/푸시
```

## 동작 개요

```mermaid
flowchart LR
  subgraph REP["GPU 레플리카 N대 (gcube)"]
    R1["컨테이너 1<br/>생성 + 상태기록"]
    R2["컨테이너 2"]
    RN["컨테이너 N"]
  end
  REP -->|"상태·메타 기록 (3초마다)"| WS[("/workspace<br/>공유 저장소<br/>(밑에 outputs/ 포함)")]
  WS -->|"폴링·이미지"| UI["웹 UI<br/>대시보드"]
```

- 각 레플리카는 기동 시 모델을 GPU에 로드한 뒤, `conditions.json`을 순회하며 이미지를 생성
- 원본 PNG는 `/workspace/outputs`, 메타 json은 `/workspace/current/<deployment>/<RUN_ID>`에 기록 (용량 중복 방지)
- 3초마다 heartbeat로 자기 상태(자원·진행·GPU 응답)를 `/workspace`에 갱신
- 웹 UI는 `/workspace`를 폴링해 전체 레플리카를 집계·표시
- 갤러리는 **이번 작업**(이번 `RUN_ID`)과 **전체**(이 deployment의 모든 `RUN_ID`) 보기를 전환 가능
- 상태는 **실행 / 멈춤 / 지연 / 완료** 로 구분
  - 지연 = 갱신이 잠깐 늦음(살아있음, 곧 회복). 오래(기본 5분) 갱신이 끊긴 레플리카는 죽은 것으로 보고 목록에서 자동 제외 (갱신을 재개하면 자동 복귀)

## 클라우드 저장소 마운트 (필수)

- 레플리카가 여러 대여도 한 화면에서 모니터링되려면, **모든 레플리카가 같은 공유 저장소를 마운트**해야 함
- gcube 워크로드 설정에서 클라우드 저장소를 `/workspace` **한 곳**에 마운트 (생성된 PNG는 그 밑 `outputs/` 폴더에 쌓임)

| 마운트 경로 | 용도 |
|---|---|
| `/workspace` | 상태·메타·시계열 + 원본 PNG(`outputs/auto`, `outputs/manual`). UI가 읽는 곳 |

- 이 경로를 마운트하지 않으면 레플리카 간 상태가 공유되지 않아 모니터링이 동작하지 않음
- 생성된 이미지는 저장소의 `outputs/auto`(자동) · `outputs/manual`(수동)에서 직접 확인 가능

## 환경변수

### 필수 (자동 생성을 시작하려면)

| 변수 | 설명 |
|---|---|
| `GEN_COUNT` | 자동 생성할 이미지 장수. `CONDITIONS_FILE`과 함께 있어야 기동과 동시에 자동 생성 시작 |
| `CONDITIONS_FILE` | 생성 조건 파일 경로 (예: `/workspace/conditions.json`) |

- 두 변수가 없으면 자동 생성은 시작되지 않고, 웹 UI의 수동 생성만 가능

### 선택

| 변수 | 기본 | 설명 |
|---|---|---|
| `MEM_MODE` | `RAM` | 모델을 어디에 올릴지. `RAM`=모델을 RAM에(VRAM 빠듯한 노드, 예: 8GB) / `VRAM`=모델을 VRAM에(RAM 빠듯한 노드, 예: 12GB) |
| `RUN_ID` | `default` | 작업 구분 키(권장). 지정하면 그 폴더에 모임, 미지정 시 `default` (예: `실험1`). deployment는 파드명에서 자동 추출 |
| `RANDOM_PICK` | false | 조건을 순서대로가 아니라 무작위로 뽑을지 |
| `STALE_SECONDS` | 120 | 이 시간 갱신 없으면 '지연'(주황) |
| `DEAD_SECONDS` | 300 | 이 시간 갱신 없으면 죽은 것으로 보고 목록에서 제외 |
| `LOAD_STALE_SECONDS` | 600 | 모델 로드 중(loading) 전용 제외 임계 |
| `HEARTBEAT_SEC` | 3 | 상태 갱신 주기(초) |
| `ZIMG_WIDTH` / `ZIMG_HEIGHT` | 1024 | 기본 해상도 |
| `ZIMG_STEPS` | 8 | 기본 스텝 |
| `ZIMG_GUIDANCE` | 0.0 | 기본 guidance |
| `WORK_DIR` / `OUTPUT_DIR` | /workspace, /workspace/outputs | 마운트 경로를 바꿀 때만 |

## 주요 API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 웹 UI |
| GET | `/api/status` | 자기 레플리카 상태 |
| GET | `/api/replicas_all` | 전체 레플리카 집계 |
| GET | `/api/resources` | 자원·생성 속도 |
| GET | `/api/images` | 이미지 목록(최근순, replica·source 필터) |
| GET | `/api/images/{id}/file` | 이미지 원본 |
| POST | `/api/generate` | 수동 1장 생성 |
| POST | `/api/job/{start,pause,resume,cancel}` | 자동 생성 잡 제어 |
| POST | `/api/control` | 대상 레플리카에 제어 명령 전달 |
## 비교 탭 (GPU 성능·비용 비교)

레플리카가 아니라 **GPU 종류 단위**로 성능·비용(특히 원/장)을 비교하는 탭. 자사(GCUBE) GPU끼리, 그리고 경쟁사 플랫폼(RunPod/Replicate/fal.ai 등)과 비교한다.

- **카탈로그**: GPU 카드 목록(자사/경쟁사). 비교 모드로 2~4개 선택 → 분석. 카드 클릭 시 상세 모달(도넛 비용 분해·조건 선택·실측/예측).
- **비교 분석**: 고른 GPU를 컬럼으로 비교. 조건(해상도·step·guidance) 종속 드롭다운, 실측/예측 기준, 원/장 막대그래프, 결과 저장(CSV/JSON).
- **가격·정책은 `gpu_profiles.json`에서** 읽는다. 성능 수치는 통계함에서 측정돼 모델명으로 조인된다(현재 v1: 성능은 placeholder, 통계함 백엔드는 다음 단계).

### gpu_profiles.json
- 위치: `/workspace/gpu_profiles.json` (RUN_ID·deployment 무관 고정, 공유 마운트).
- 적용: 파일을 해당 위치에 두거나, 비교 탭 **⬆ 프로파일 불러오기**로 업로드 → **↻ 새로고침**.
- 백업: **⬇ 내보내기**로 내려받고, 복구 시 다시 넣고 새로고침.
- 스키마: `gpu_profiles.sample.json` 참고. `gpus[].model`은 측정된 GPU명과 일치해야 성능이 연결됨. 성능 수치는 적지 않는다.

### API
- `GET /api/gpu_profiles` — 현재 프로파일 반환(없으면 빈 골격).
- `POST /api/gpu_profiles` — 업로드된 프로파일을 `/workspace/gpu_profiles.json`에 저장(providers 배열 필수).