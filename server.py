"""
zimage-auto-light — Z-Image-Turbo 자동 이미지 생성 REST API (분산/레플리카 대응)

레플리카 구조
- 각 레플리카(파드)는 독립 컨테이너. 자기 server·모델·GPU·메모리를 가짐
- 유일한 공유 지점은 마운트된 작업 폴더(WORK_DIR=/workspace) 와 보존 폴더(OUTPUT_DIR=/outputs)
- 레플리카 식별 = 파드 이름(hostname)

폴더 역할 분리 (A방식)
- OUTPUT_DIR (/outputs)  : 보존용. 실제 PNG 전부 쌓임(아카이브). /workspace 밖 별도 마운트
    - /outputs/auto/     : 자동화(환경변수 GEN_COUNT) 생성분
    - /outputs/manual/   : UI 수동 테스트 생성분
- CURRENT_DIR (/workspace/current/run_<RUN_ID>) : UI 렌더링용(이번 실행만)
    - <id>.json              : 이미지 메타(프롬프트·seed·replica·source·config + 보존 PNG 경로). 가벼움
    - status/<pod>.json      : 레플리카 하트비트(현재 스냅샷)
    - history/<pod>.recent.jsonl : 시계열 로우데이터(최근, 10초 간격)
    - history/<pod>.rollup.jsonl : 시계열 압축(1분 평균, 장기 보존)
- UI는 CURRENT_DIR만 스캔 → 이전 작업물과 안 섞임. 어느 레플리카가 응답하든 같은 폴더라 일관

이미지 저장: PNG는 OUTPUT_DIR(auto|manual)에 1번만(용량 중복 X), 메타 json만 CURRENT_DIR에 → 둘 분리
"""

import os
import json
import time
import socket
import random
import threading
import datetime as dt
from collections import deque
from pathlib import Path

import torch
from fastapi import FastAPI, Body, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from sdnq import SDNQConfig  # noqa: F401  (SDNQ 로더 등록)
from diffusers import ZImagePipeline
from PIL import Image

try:
    import psutil
except Exception:
    psutil = None
try:
    import pynvml
    pynvml.nvmlInit()
    _NVML = True
except Exception:
    _NVML = False

# ─────────────────────────────────────────────────────────────
# 설정 / 경로
# ─────────────────────────────────────────────────────────────
MODEL_REPO = os.getenv("MODEL_REPO", "Disty0/Z-Image-Turbo-SDNQ-uint4-svd-r32")
WORK_DIR = Path(os.getenv("WORK_DIR", "/workspace"))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/outputs"))   # /workspace 밖 별도 마운트
OUTPUT_AUTO_DIR = OUTPUT_DIR / "auto"      # 자동화 생성 PNG
OUTPUT_MANUAL_DIR = OUTPUT_DIR / "manual"  # UI 수동 테스트 생성 PNG
REPLICA_ID = socket.gethostname()   # 파드 이름 (예: dep2520-75f955bf6f-5phj7)
_run_id_env = os.getenv("RUN_ID", "").strip()
RUN_ID_AUTO = not _run_id_env   # 사용자가 지정 안 함 → 자동 생성
if _run_id_env:
    RUN_ID = _run_id_env
else:
    # RUN_ID 미지정 시: 같은 '배포'의 파드는 항상 같은 run 폴더를 써야 서로 보인다.
    # 파드 이름 <배포>-<RS해시>-<파드해시> 에서 RS해시·파드해시 둘 다 떼고 배포명만 남긴다.
    # → 재배포(새 ReplicaSet)·노드 교체로 RS가 바뀌어도 같은 폴더를 공유한다.
    # 예: dep2520-5bd79945f5-8rtfc → auto-dep2520
    _parts = REPLICA_ID.rsplit("-", 2)
    _base = _parts[0] if len(_parts) == 3 else REPLICA_ID
    RUN_ID = "auto-" + _base
CURRENT_DIR = WORK_DIR / "current" / f"run_{RUN_ID}"   # UI 렌더링용 (실행 격리 키)
STATUS_DIR = CURRENT_DIR / "status"
HISTORY_DIR = CURRENT_DIR / "history"
CONTROL_DIR = CURRENT_DIR / "control"   # 타겟 제어 명령함: UI가 control/<파드>.json 에 쓰면 해당 레플리카가 읽어 실행
STARTED_AT = dt.datetime.now()      # 레플리카 시작 시각 (uptime용)

DEFAULT_WIDTH = int(os.getenv("ZIMG_WIDTH", "1024"))
DEFAULT_HEIGHT = int(os.getenv("ZIMG_HEIGHT", "1024"))
DEFAULT_STEPS = int(os.getenv("ZIMG_STEPS", "8"))
DEFAULT_GUIDANCE = float(os.getenv("ZIMG_GUIDANCE", "0.0"))

GEN_COUNT = os.getenv("GEN_COUNT", "").strip()
CONDITIONS_FILE = os.getenv("CONDITIONS_FILE", "").strip()
RANDOM_PICK = os.getenv("RANDOM_PICK", "false").strip().lower() in ("1", "true", "yes", "y")

STALE_SECONDS = float(os.getenv("STALE_SECONDS", "120"))  # 이 시간 넘게 갱신 없으면 죽은 레플리카로 간주. 노하드(디스크리스) tier3 배려 — status 쓰기가 네트워크로 밀릴 수 있어 넉넉히
LOAD_STALE_SECONDS = float(os.getenv("LOAD_STALE_SECONDS", "600"))  # 'loading'(모델 로드 중)에만 적용하는 임계. 노하드에선 모델 로드 자체가 네트워크라 오래 걸려 죽음 오판 방지
REP_CACHE_SEC = float(os.getenv("REP_CACHE_SEC", "1.5"))  # status 폴더 읽기 캐시. 노하드 대비 — UI 폴링마다 폴더 전체를 다시 읽지 않음(이 시간만큼 화면이 살짝 지연될 수 있음)
HEARTBEAT_SEC = float(os.getenv("HEARTBEAT_SEC", "3"))    # status 갱신 + control 확인 주기(한 사이클로 묶음)
HISTORY_SEC = float(os.getenv("HISTORY_SEC", "10"))       # 시계열 로우데이터 샘플 주기
RECENT_KEEP = int(os.getenv("RECENT_KEEP", "180"))        # recent 보관 점수 (10s×180=30분)
ROLLUP_KEEP = int(os.getenv("ROLLUP_KEEP", "2880"))       # rollup 보관 점수 (1min×2880=48시간)
STAT_KEEP = 1000                                          # 생성시간/VRAM 통계 표본 보관 수

app = FastAPI(title="zimage-auto-light")
_INDEX_HTML = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")

# 정적 파일(css/js/logo) 서빙 — index.html 이 /static/* 로 참조
_STATIC_DIR = Path(__file__).parent / "static"
if _STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

for d in (OUTPUT_DIR, OUTPUT_AUTO_DIR, OUTPUT_MANUAL_DIR, CURRENT_DIR, STATUS_DIR, HISTORY_DIR, CONTROL_DIR):
    d.mkdir(parents=True, exist_ok=True)

print(f"[ INFO ] REPLICA(pod) = {REPLICA_ID}", flush=True)
print(f"[ INFO ] RUN_ID = {RUN_ID}" + ("  (자동 생성)" if RUN_ID_AUTO else ""), flush=True)
print(f"[ INFO ] OUTPUT_DIR(보존) = {OUTPUT_DIR}  (auto/ , manual/)", flush=True)
print(f"[ INFO ] CURRENT_DIR(UI)  = {CURRENT_DIR}", flush=True)

# 모델 로딩 동안에도 화면에 즉시 뜨도록, 로드 시작 전 'loading' 상태를 한 번 기록
try:
    _ld_target = STATUS_DIR / f"{REPLICA_ID}.json"
    _ld_tmp = STATUS_DIR / f".{REPLICA_ID}.json.tmp"
    _ld_tmp.write_text(json.dumps({
        "replica": REPLICA_ID,
        "updated": dt.datetime.now().isoformat(timespec="seconds"),
        "started_at": STARTED_AT.isoformat(timespec="seconds"),
        "job_state": "loading", "generated": 0,
    }, ensure_ascii=False), encoding="utf-8")
    os.replace(_ld_tmp, _ld_target)   # 원자적 — 컨테이너 인식의 첫 신호라 부분쓰기 방지
except Exception:
    pass

# ─────────────────────────────────────────────────────────────
# 모델 로드
# ─────────────────────────────────────────────────────────────
print(f"[ MODEL ] loading {MODEL_REPO} ...", flush=True)
pipe = ZImagePipeline.from_pretrained(MODEL_REPO, torch_dtype=torch.bfloat16)
pipe.enable_model_cpu_offload()
print("[ MODEL ] ready", flush=True)

# ─────────────────────────────────────────────────────────────
# 공유 상태(레플리카 로컬)
# ─────────────────────────────────────────────────────────────
gpu_lock = threading.Lock()
_seq = 0
_seq_lock = threading.Lock()
MY_GENERATED = 0      # 이 레플리카가 만든 장 수
TOTAL_GEN_SECONDS = 0.0  # 누적 생성 시간(초) — 가동률 계산용
LAST_GEN = {"seconds": None, "peak_vram_mb": None, "device_used_mb": None}
GEN_TIMES = deque(maxlen=STAT_KEEP)   # 생성 소요시간(초) 표본
VRAM_PEAKS = deque(maxlen=STAT_KEEP)  # 생성 VRAM peak(GB) 표본


def _stat(seq):
    """표본 리스트 → (평균, 최소, 최대). 비어있으면 (None,None,None)."""
    if not seq:
        return None, None, None
    return round(sum(seq) / len(seq), 2), round(min(seq), 2), round(max(seq), 2)


def _gpu_snapshot():
    """현재 GPU/RAM 스냅샷 (GB)."""
    out = {"vram_used_gb": None, "vram_total_gb": None, "util": None,
           "ram_used_gb": None, "ram_total_gb": None, "ram_percent": None, "gpu_ok": None}
    if torch.cuda.is_available():
        try:
            free_b, total_b = torch.cuda.mem_get_info()
            out["vram_used_gb"] = round((total_b - free_b) / 1024**3, 2)
            out["vram_total_gb"] = round(total_b / 1024**3, 1)
            out["gpu_ok"] = True   # CUDA 응답 + VRAM 조회 성공 → GPU 살아있음
        except Exception:
            out["gpu_ok"] = False  # CUDA는 있다는데 조회 실패 → GPU 이상
        if _NVML:
            try:
                h = pynvml.nvmlDeviceGetHandleByIndex(0)
                out["util"] = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
            except Exception:
                pass
    else:
        out["gpu_ok"] = False      # CUDA 자체가 안 보임
    if psutil is not None:
        vm = psutil.virtual_memory()
        out["ram_used_gb"] = round(vm.used / 1024**3, 1)
        out["ram_total_gb"] = round(vm.total / 1024**3, 1)
        out["ram_percent"] = vm.percent
    return out


def _next_seq():
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


def _run_generation(prompt, width, height, steps, guidance, seed, source, config_file=None):
    """1장 생성 → PNG는 OUTPUT_DIR(보존), 메타는 CURRENT_DIR(UI). gpu_lock 안에서 호출."""
    global MY_GENERATED, TOTAL_GEN_SECONDS
    if seed is None:
        seed = random.randint(0, 2**32 - 1)
    generator = torch.Generator().manual_seed(int(seed))

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    start_dt = dt.datetime.now()
    t0 = time.time()

    image: Image.Image = pipe(
        prompt=prompt, width=width, height=height,
        num_inference_steps=steps, guidance_scale=guidance, generator=generator,
    ).images[0]

    elapsed = round(time.time() - t0, 2)
    finish_dt = dt.datetime.now()
    peak_gb = None
    if torch.cuda.is_available():
        peak_gb = round(torch.cuda.max_memory_allocated() / 1024**3, 2)
        LAST_GEN["seconds"] = elapsed
        LAST_GEN["peak_vram_mb"] = round(peak_gb * 1024, 1)
        free_b, total_b = torch.cuda.mem_get_info()
        LAST_GEN["device_used_mb"] = round((total_b - free_b) / 1024**2, 1)
    GEN_TIMES.append(elapsed)
    TOTAL_GEN_SECONDS += elapsed
    if peak_gb is not None:
        VRAM_PEAKS.append(peak_gb)

    seq = _next_seq()
    ts = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = f"{REPLICA_ID}_{ts}_{seq:05d}_seed{seed}"

    # PNG → 보존 폴더(source별): auto / manual
    sub = "manual" if source == "manual" else "auto"
    png_dir = OUTPUT_MANUAL_DIR if sub == "manual" else OUTPUT_AUTO_DIR
    png_path = png_dir / f"{stem}.png"
    image.save(png_path, format="PNG")
    try:
        size_bytes = png_path.stat().st_size
    except Exception:
        size_bytes = None

    # 메타 → UI 폴더 (가벼움, 실제 PNG 경로 포함)
    meta = {
        "id": stem,
        "png": str(png_path),
        "png_sub": sub,                 # auto | manual (서빙·필터용)
        "size_bytes": size_bytes,
        "replica": REPLICA_ID,
        "prompt": prompt, "seed": int(seed),
        "width": width, "height": height, "steps": steps, "guidance": guidance,
        "source": source,               # auto | manual
        "config_file": config_file,     # AUTO일 때 사용한 conditions 파일명 (MANUAL이면 None)
        "run_id": RUN_ID,
        "started": start_dt.isoformat(timespec="seconds"),    # 생성 시작
        "finished": finish_dt.isoformat(timespec="seconds"),  # 생성 종료
        "elapsed_s": elapsed,                                  # 걸린 시간(초)
        "created": finish_dt.isoformat(timespec="seconds"),   # (하위호환) = finished
    }
    try:
        (CURRENT_DIR / f"{stem}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[ WARN ] 메타 기록 실패: {e}", flush=True)

    MY_GENERATED += 1
    return meta


# ─────────────────────────────────────────────────────────────
# 잡 (일시중지/재개/취소 — 이번 단계는 '이 레플리카'에만 적용)
# ─────────────────────────────────────────────────────────────
class JobManager:
    def __init__(self):
        self.state = "idle"
        self.total = 0
        self.completed = 0
        self.message = ""
        self.config_file = None
        self.job_started = None    # 현재(또는 마지막) 작업 시작 시각
        self.job_finished = None   # 작업 종료 시각
        self._cancel = threading.Event()
        self._resume = threading.Event()
        self._thread = None

    def status(self):
        return {"state": self.state, "total": self.total, "completed": self.completed,
                "message": self.message, "config_file": self.config_file,
                "busy": self.state in ("running", "paused")}

    def start(self, conditions, count, random_pick, config_file=None):
        if self.state in ("running", "paused"):
            raise HTTPException(409, "이미 작업이 진행 중입니다.")
        if not isinstance(conditions, list) or not conditions:
            raise HTTPException(400, "조건 목록이 비어 있습니다.")
        self.state = "running"; self.total = int(count); self.completed = 0
        self.message = ""; self.config_file = config_file
        self.job_started = dt.datetime.now(); self.job_finished = None
        self._cancel.clear(); self._resume.set()
        self._thread = threading.Thread(target=self._worker,
                                        args=(conditions, int(count), bool(random_pick), config_file),
                                        daemon=True)
        self._thread.start()

    def _pick(self, conds, idx, rnd):
        return random.choice(conds) if rnd else conds[idx % len(conds)]

    def _worker(self, conds, count, rnd, config_file):
        # config_file 이 있으면 source=auto(자동화), 없으면 manual(개수>1 수동)
        src = "auto" if config_file else "manual"
        try:
            for i in range(count):
                if self._cancel.is_set():
                    self.state = "cancelled"; self.message = f"{self.completed}장 후 취소"; self.job_finished = dt.datetime.now(); return
                self._resume.wait()
                if self._cancel.is_set():
                    self.state = "cancelled"; self.message = f"{self.completed}장 후 취소"; self.job_finished = dt.datetime.now(); return
                c = self._pick(conds, i, rnd)
                with gpu_lock:
                    _run_generation(c.get("prompt", ""), int(c.get("width", DEFAULT_WIDTH)),
                                    int(c.get("height", DEFAULT_HEIGHT)), int(c.get("steps", DEFAULT_STEPS)),
                                    float(c.get("guidance", DEFAULT_GUIDANCE)), c.get("seed"),
                                    src, config_file)
                self.completed += 1
                _write_heartbeat()   # 매 장 직후 하트비트 강제 갱신 — 무거운 추론으로 주기 스레드가 밀려도 '죽음' 오판 방지
            self.state = "done"; self.message = f"{self.completed}장 완료"; self.job_finished = dt.datetime.now()
        except Exception as e:
            self.state = "error"; self.message = str(e); self.job_finished = dt.datetime.now()

    def pause(self):
        if self.state == "running":
            self._resume.clear(); self.state = "paused"

    def resume(self):
        if self.state == "paused":
            self._resume.set(); self.state = "running"

    def cancel(self):
        if self.state in ("running", "paused"):
            self._cancel.set(); self._resume.set()


job = JobManager()


def _load_conditions_file(name):
    p = Path(name)
    if not p.is_absolute():
        p = WORK_DIR / name
    if not p.exists():
        raise HTTPException(400, f"CONFIG 파일을 찾을 수 없습니다: {p}")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(data, list) and data
        return data
    except Exception as e:
        raise HTTPException(400, f"CONFIG 파일 파싱 실패: {e}")


# ─────────────────────────────────────────────────────────────
# 하트비트: status/<pod>.json (현재 스냅샷)
# ─────────────────────────────────────────────────────────────
def _status_payload():
    snap = _gpu_snapshot()
    js = job.status()
    avg_s, min_s, max_s = _stat(GEN_TIMES)
    vram_avg, _vmin, vram_peak = _stat(VRAM_PEAKS)
    now = dt.datetime.now()
    uptime_s = max(1, int((now - STARTED_AT).total_seconds()))
    busy_ratio = round(min(100.0, TOTAL_GEN_SECONDS / uptime_s * 100), 1)   # 가동률 = 누적 생성시간/가동시간
    throughput_hr = round(MY_GENERATED / (uptime_s / 3600.0), 1) if MY_GENERATED else 0.0  # 시간당 실제 생성량
    throughput_max_hr = round(3600.0 / avg_s, 1) if avg_s else None          # 현재 속도 기준 이론 최대/시간
    vram_eff = vram_avg                                                       # 장당 평균 VRAM peak(효율)
    return {
        "replica": REPLICA_ID,
        "updated": now.isoformat(timespec="seconds"),
        "started_at": STARTED_AT.isoformat(timespec="seconds"),
        "uptime_s": uptime_s,
        "job_started": job.job_started.isoformat(timespec="seconds") if job.job_started else None,
        "job_finished": job.job_finished.isoformat(timespec="seconds") if job.job_finished else None,
        "busy_ratio": busy_ratio,
        "gen_seconds_total": round(TOTAL_GEN_SECONDS, 1),   # 누적 생성시간(가동률 분자)
        "throughput_hr": throughput_hr,
        "throughput_max_hr": throughput_max_hr,
        "vram_eff_gb": vram_eff,
        "vram_used_gb": snap["vram_used_gb"],
        "vram_total_gb": snap["vram_total_gb"],
        "vram_peak_gb": vram_peak,           # 생성 VRAM peak (빨강 판단 기준)
        "vram_avg_gb": vram_avg,             # 생성 VRAM 평균
        "ram_used_gb": snap["ram_used_gb"],
        "ram_total_gb": snap["ram_total_gb"],
        "util": snap["util"],
        "generated": MY_GENERATED,
        "last_gen_s": LAST_GEN["seconds"],
        "avg_gen_s": avg_s,                  # 평균 생성 시간
        "min_gen_s": min_s,                  # 최단
        "max_gen_s": max_s,                  # 최장
        "job_state": js["state"],
        "job_total": js["total"],
        "job_completed": js["completed"],
        "job_message": js["message"],     # "N장 후 취소" / "N장 완료" 등 — UI 상세에 사유 표시
        "config_file": js["config_file"],
        "gpu_ok": snap.get("gpu_ok"),      # 레플리카 자체 GPU 응답 여부(살아있는데 GPU만 이상한 경우 구분용)
    }


_hb_lock = threading.Lock()

def _write_heartbeat():
    # 노하드(디스크리스) 대비: 임시 파일에 쓴 뒤 원자적 교체 → 네트워크 끊김으로 인한 부분쓰기/깨진 json 방지.
    # payload 생성은 lock 밖(가벼움), 파일 교체만 직렬화(heartbeat 스레드 + 생성 워커 동시 쓰기 충돌 방지).
    try:
        payload = json.dumps(_status_payload(), ensure_ascii=False)
    except Exception as e:
        print(f"[ WARN ] 하트비트 payload 실패: {e}", flush=True); return
    try:
        with _hb_lock:
            target = STATUS_DIR / f"{REPLICA_ID}.json"
            tmp = STATUS_DIR / f".{REPLICA_ID}.json.tmp"
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, target)
    except Exception as e:
        print(f"[ WARN ] 하트비트 쓰기 실패: {e}", flush=True)


def _heartbeat_loop():
    while True:
        _check_control()    # control 읽기 + status 쓰기를 한 사이클로 묶어 노하드 네트워크 왕복 최소화
        _write_heartbeat()
        time.sleep(HEARTBEAT_SEC)


# ─────────────────────────────────────────────────────────────
# 타겟 제어: 각 레플리카가 자기 control/<파드>.json 을 읽어 명령 실행
#   - UI는 /api/control 로 명령을 써두고, 해당 레플리카가 읽어서 자기 job 에 적용
#   - 서비스 URL 은 임의 파드로 분배되므로, '쓰기'를 공유 저장소로 우회해 타겟을 지정한다
#   - 재시작한 레플리카가 옛 명령을 잘못 실행하지 않게, 자기 시작 시각 이후 명령만 실행
#   - 노하드(디스크리스) 대비: 별도 폴링 스레드를 두지 않고 heartbeat 사이클에 묶어 네트워크
#     왕복을 최소화. 생성 중에도 heartbeat 스레드가 계속 돌아 pause/cancel 이 반영된다.
# ─────────────────────────────────────────────────────────────
_last_control_ts = None

def _check_control():
    """control/<파드>.json 에 새 명령이 있으면 1건 적용."""
    global _last_control_ts
    cf = CONTROL_DIR / f"{REPLICA_ID}.json"
    try:
        if cf.exists():
            d = json.loads(cf.read_text(encoding="utf-8"))
            ts = d.get("ts")
            if ts and ts != _last_control_ts:
                _last_control_ts = ts
                try:
                    cmd_dt = dt.datetime.fromisoformat(ts)
                except Exception:
                    cmd_dt = None
                # 시작 이후에 쓰인 명령만 실행(재시작 시 잔존 명령 무시)
                if cmd_dt is None or cmd_dt >= STARTED_AT:
                    act = d.get("action")
                    if act == "pause":  job.pause()
                    elif act == "resume": job.resume()
                    elif act == "cancel": job.cancel()
    except Exception as e:
        print(f"[ WARN ] control 확인 실패: {e}", flush=True)


# ─────────────────────────────────────────────────────────────
# 시계열: recent(로우, 10초) + rollup(1분 평균, 장기)
# ─────────────────────────────────────────────────────────────
_recent = deque(maxlen=RECENT_KEEP)
_minute_buf = []          # 현재 1분 구간 샘플
_minute_key = None        # 현재 분(YYYYmmddHHMM)
RECENT_FILE = HISTORY_DIR / f"{REPLICA_ID}.recent.jsonl"
ROLLUP_FILE = HISTORY_DIR / f"{REPLICA_ID}.rollup.jsonl"


def _avg(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


def _history_sample():
    """10초마다 호출: recent 갱신 + 1분 단위로 rollup 누적."""
    global _minute_key
    snap = _gpu_snapshot()
    now = dt.datetime.now()
    point = {"t": now.isoformat(timespec="seconds"),
             "vram": snap["vram_used_gb"], "util": snap["util"], "ram": snap["ram_used_gb"]}
    _recent.append(point)
    # recent 파일은 작으니 매번 덮어쓰기
    try:
        RECENT_FILE.write_text("\n".join(json.dumps(p) for p in _recent), encoding="utf-8")
    except Exception:
        pass

    # 분 단위 롤업
    mkey = now.strftime("%Y%m%d%H%M")
    if _minute_key is None:
        _minute_key = mkey
    if mkey != _minute_key and _minute_buf:
        agg = {"t": _minute_key,
               "vram": _avg([s["vram"] for s in _minute_buf]),
               "util": _avg([s["util"] for s in _minute_buf]),
               "ram": _avg([s["ram"] for s in _minute_buf])}
        _append_rollup(agg)
        _minute_buf.clear()
        _minute_key = mkey
    _minute_buf.append(point)


def _append_rollup(agg):
    try:
        lines = []
        if ROLLUP_FILE.exists():
            lines = ROLLUP_FILE.read_text(encoding="utf-8").splitlines()
        lines.append(json.dumps(agg))
        if len(lines) > ROLLUP_KEEP:
            lines = lines[-ROLLUP_KEEP:]
        ROLLUP_FILE.write_text("\n".join(lines), encoding="utf-8")
    except Exception:
        pass


def _history_loop():
    while True:
        _history_sample()
        time.sleep(HISTORY_SEC)


def _read_jsonl(path):
    out = []
    try:
        if path.exists():
            for ln in path.read_text(encoding="utf-8").splitlines():
                ln = ln.strip()
                if ln:
                    try:
                        out.append(json.loads(ln))
                    except Exception:
                        continue
    except Exception:
        pass
    return out


# ─────────────────────────────────────────────────────────────
# 기동
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
def _startup():
    threading.Thread(target=_heartbeat_loop, daemon=True).start()
    threading.Thread(target=_history_loop, daemon=True).start()
    _write_heartbeat()
    if GEN_COUNT and CONDITIONS_FILE:
        try:
            conds = _load_conditions_file(CONDITIONS_FILE)
            job.start(conds, int(GEN_COUNT), RANDOM_PICK, config_file=CONDITIONS_FILE)
            print(f"[ AUTO ] 자동화 시작: {GEN_COUNT}장 / {CONDITIONS_FILE} / random={RANDOM_PICK}", flush=True)
        except Exception as e:
            print(f"[ AUTO ] 자동화 시작 실패: {e}", flush=True)
    else:
        print("[ AUTO ] 수동 모드", flush=True)


# ─────────────────────────────────────────────────────────────
# 엔드포인트
# ─────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def index():
    return _INDEX_HTML


@app.post("/api/generate")
def generate(
    prompt: str = Body(..., embed=True),
    width: int = Body(DEFAULT_WIDTH),
    height: int = Body(DEFAULT_HEIGHT),
    num_inference_steps: int = Body(DEFAULT_STEPS),
    guidance_scale: float = Body(DEFAULT_GUIDANCE),
    seed: int = Body(None),
    count: int = Body(1),
):
    if job.state in ("running", "paused"):
        raise HTTPException(409, "진행 중인 작업이 있습니다. 일시중지 후 취소하신 다음 다시 진행해주세요.")
    cond = {"prompt": prompt, "width": width, "height": height,
            "steps": num_inference_steps, "guidance": guidance_scale, "seed": seed}
    if count and count > 1:
        job.start([cond], int(count), random_pick=False, config_file=None)  # 수동 다량
        return JSONResponse({"mode": "job", "status": job.status()})
    with gpu_lock:
        meta = _run_generation(prompt, width, height, num_inference_steps,
                               guidance_scale, seed, "manual", config_file=None)
    return JSONResponse({"mode": "single", "meta": meta})


@app.get("/api/status")
def status():
    return job.status()


@app.post("/api/job/start")
def job_start(count: int = Body(None), conditions_file: str = Body(None), random_pick: bool = Body(None)):
    c = count if count is not None else (int(GEN_COUNT) if GEN_COUNT else 0)
    f = conditions_file if conditions_file is not None else CONDITIONS_FILE
    r = random_pick if random_pick is not None else RANDOM_PICK
    if not c or not f:
        raise HTTPException(400, "count 와 conditions_file 이 필요합니다.")
    job.start(_load_conditions_file(f), c, r, config_file=f)
    return job.status()


@app.post("/api/job/pause")
def job_pause():
    job.pause(); return job.status()


@app.post("/api/job/resume")
def job_resume():
    job.resume(); return job.status()


@app.post("/api/job/cancel")
def job_cancel():
    job.cancel(); return job.status()


@app.post("/api/control")
def control(targets: list = Body(...), action: str = Body(...)):
    """타겟 제어: 선택한 레플리카들의 control/<파드>.json 에 명령을 기록한다.
    이 요청은 임의 파드가 받아도 되며(공유 저장소), 각 타겟 레플리카가 자기 파일을 폴링해 실행한다.
    action: pause | resume | cancel."""
    if action not in ("pause", "resume", "cancel"):
        raise HTTPException(400, "action 은 pause|resume|cancel 중 하나여야 합니다.")
    if not isinstance(targets, list) or not targets:
        raise HTTPException(400, "targets(레플리카 이름 목록)가 비어 있습니다.")
    ts = dt.datetime.now().isoformat()   # microsecond 포함 → 같은 초 연속 명령도 구분
    written = []
    for t in targets:
        try:
            (CONTROL_DIR / f"{t}.json").write_text(
                json.dumps({"action": action, "ts": ts}, ensure_ascii=False), encoding="utf-8")
            written.append(t)
        except Exception as e:
            print(f"[ WARN ] control 기록 실패({t}): {e}", flush=True)
    return {"action": action, "ts": ts, "written": written}


@app.get("/api/resources")
def resources():
    """이 레플리카(응답한 레플리카)의 현재 자원 + 생성 통계."""
    snap = _gpu_snapshot()
    avg_s, min_s, max_s = _stat(GEN_TIMES)
    vram_avg, _vmin, vram_peak = _stat(VRAM_PEAKS)
    return {
        "replica": REPLICA_ID,
        "gpu": snap,
        "last_gen": LAST_GEN,
        "gen_avg_s": avg_s, "gen_min_s": min_s, "gen_max_s": max_s,
        "vram_avg_gb": vram_avg, "vram_peak_gb": vram_peak,
        "generated": MY_GENERATED,
    }


@app.get("/api/conditions")
def list_conditions():
    files = []
    try:
        if WORK_DIR.exists():
            files = sorted(p.name for p in WORK_DIR.glob("*.json") if p.is_file())
    except Exception:
        pass
    return {"work_dir": str(WORK_DIR), "files": files}


@app.get("/api/model")
def model_info():
    repo = MODEL_REPO
    base = repo.split("/")[-1].split("-SDNQ")[0]
    low = repo.lower()
    dtype = next((d for d in ("uint4", "int8", "int4", "uint8", "fp8") if d in low), "?")
    return {"repo": repo, "name": base, "dtype": dtype, "run_id": RUN_ID, "run_auto": RUN_ID_AUTO}


@app.get("/api/replicas")
def list_replicas():
    """CURRENT_DIR/status 스캔 → 살아있는 레플리카 현황 (대시보드용).

    살아있는 판단 = 하트비트(updated)가 STALE_SECONDS 이내에 갱신됨.
    죽은 파드는 status 파일이 남아도 갱신이 멈추므로 stale 로 걸러냄.
    파일 mtime 도 함께 보아 시계 오차/동기화 지연을 보완.
    include_stale=True 면 죽은 것도 포함(_stale 플래그 표시).
    """
    return _replicas(include_stale=False)


@app.get("/api/replicas_all")
def list_replicas_all():
    """죽은 레플리카까지 포함 (대시보드 '죽은 레플리카 포함' 옵션용)."""
    return _replicas(include_stale=True)


_rep_cache = {"ts": 0.0, "reps": None}

def _read_status_dir():
    """status 폴더 전체를 읽어 레플리카 dict 리스트(+_age_s,_stale) 반환.
    노하드 대비: REP_CACHE_SEC 동안 결과를 캐시해 UI 폴링마다 폴더 전체를 다시 읽지 않는다."""
    now_m = time.time()
    if _rep_cache["reps"] is not None and (now_m - _rep_cache["ts"]) < REP_CACHE_SEC:
        return _rep_cache["reps"]
    now = dt.datetime.now()
    reps = []
    try:
        for p in STATUS_DIR.glob("*.json"):
            try:
                r = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            age = None
            try:
                age = (now - dt.datetime.fromisoformat(r.get("updated"))).total_seconds()
            except Exception:
                pass
            try:
                mtime_age = time.time() - p.stat().st_mtime
                age = mtime_age if age is None else min(age, mtime_age)
            except Exception:
                pass
            r["_age_s"] = round(age, 1) if age is not None else None
            # 모델 로드 중('loading')은 노하드에서 오래 걸릴 수 있어 더 관대한 임계 적용
            limit = LOAD_STALE_SECONDS if r.get("job_state") == "loading" else STALE_SECONDS
            r["_stale"] = (age is not None and age > limit)
            reps.append(r)
    except Exception:
        pass
    reps.sort(key=lambda r: r.get("replica", ""))
    _rep_cache["ts"] = now_m; _rep_cache["reps"] = reps
    return reps


def _replicas(include_stale=False):
    reps_all = _read_status_dir()
    dead_count = sum(1 for r in reps_all if r.get("_stale"))
    reps = reps_all if include_stale else [r for r in reps_all if not r.get("_stale")]
    alive = [r for r in reps_all if not r.get("_stale")]
    total_gen = sum(r.get("generated", 0) or 0 for r in alive)
    running = [r for r in alive if r.get("job_state") == "running"]
    paused = [r for r in alive if r.get("job_state") == "paused"]
    done = [r for r in alive if r.get("job_state") in ("done", "idle", "cancelled", "error")]
    utils = [r.get("util") for r in alive if r.get("util") is not None]
    summary = {
        "replicas": len(alive),
        "total_generated": total_gen,
        "running": len(running),
        "avg_util": round(sum(utils) / len(utils)) if utils else None,
        "states": {"running": len(running), "paused": len(paused),
                   "done": len(done), "dead": dead_count},
    }
    return {"run_id": RUN_ID, "summary": summary, "replicas": reps, "stale_seconds": STALE_SECONDS}


_img_meta_cache = {}   # path(str) -> meta(dict, _mtime 포함). 메타 json은 생성 시 1회 기록 후 불변 → 한 번 읽으면 재사용

@app.get("/api/images")
def list_images(replica: str = None, source: str = None, scope: str = "run", limit: int = 1000):
    """메타 json 스캔 → 이미지 목록(최근순).
    scope='run'(기본): 이번 실행(CURRENT_DIR)만. scope='all': 저장소의 모든 실행(run_* 전체 폴더) 집계.
    replica 필터(파드 이름), source 필터(auto|manual) 옵션.
    노하드 대비: 폴더 목록만 새로 훑고, 이미 읽은 메타는 캐시에서 재사용(매번 전체 재읽기 방지)."""
    if scope == "all":
        runs_root = CURRENT_DIR.parent   # /workspace/current
        dirs = sorted((d for d in runs_root.glob("run_*") if d.is_dir())) if runs_root.exists() else []
    else:
        dirs = [CURRENT_DIR]
    seen = {}   # id -> meta : 같은 id면 최신 것만 (실행 간 중복 방지)
    for d in dirs:
        try:
            for p in d.glob("*.json"):
                key = str(p)
                m = _img_meta_cache.get(key)
                if m is None:                      # 캐시에 없을 때만 디스크 읽기(= 새로 생긴 메타)
                    try:
                        mt = p.stat().st_mtime
                        m = json.loads(p.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    m["_mtime"] = mt
                    _img_meta_cache[key] = m
                iid = m.get("id") or p.stem
                prev = seen.get(iid)
                if prev and prev.get("_mtime", 0) >= m.get("_mtime", 0):
                    continue
                seen[iid] = m
        except Exception:
            continue
    metas = list(seen.values())
    if replica:
        metas = [m for m in metas if m.get("replica") == replica]
    if source:
        metas = [m for m in metas if (m.get("png_sub") or m.get("source")) == source]
    metas.sort(key=lambda m: m.get("_mtime", 0), reverse=True)
    if limit and len(metas) > limit:
        metas = metas[:limit]
    return metas


@app.get("/api/images/{image_id}/file")
def image_file(image_id: str):
    """보존 폴더의 실제 PNG 서빙. auto/manual 하위폴더(+레거시 ui/루트)에서 탐색.
    어느 레플리카든 공유 폴더라 서빙 가능."""
    for d in (OUTPUT_AUTO_DIR, OUTPUT_MANUAL_DIR, OUTPUT_DIR / "ui", OUTPUT_DIR):
        path = d / f"{image_id}.png"
        if path.exists():
            # 이미지 id는 고유·불변 → 브라우저가 장기 캐시하도록(한 번 받으면 재다운로드 안 함)
            return FileResponse(path, media_type="image/png",
                                headers={"Cache-Control": "public, max-age=31536000, immutable"})
    raise HTTPException(404, "파일이 없습니다.")


@app.get("/api/replica/{replica_id}/history")
def replica_history(replica_id: str, range: str = "live"):
    """레플리카 시계열. range=live(recent 로우) | 1h | 6h | all (rollup 압축).
    공유 폴더라 어느 레플리카가 응답하든 해당 replica_id 파일을 읽어 제공."""
    recent = _read_jsonl(HISTORY_DIR / f"{replica_id}.recent.jsonl")
    rollup = _read_jsonl(HISTORY_DIR / f"{replica_id}.rollup.jsonl")
    started_at = None
    try:
        sp = STATUS_DIR / f"{replica_id}.json"
        if sp.exists():
            started_at = json.loads(sp.read_text(encoding="utf-8")).get("started_at")
    except Exception:
        pass

    if range == "live":
        points, resolution = recent, "10s"
    else:
        resolution = "1m"
        if range == "all":
            points = rollup
        else:
            hours = {"1h": 1, "6h": 6}.get(range, 6)
            cutoff = dt.datetime.now() - dt.timedelta(hours=hours)
            def _ok(pt):
                try:
                    return dt.datetime.strptime(pt["t"], "%Y%m%d%H%M") >= cutoff
                except Exception:
                    return True
            points = [p for p in rollup if _ok(p)]
    return {"replica": replica_id, "range": range, "resolution": resolution,
            "started_at": started_at, "points": points}