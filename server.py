"""
zimage-auto-light — Z-Image-Turbo 자동 이미지 생성 REST API (분산/레플리카 대응)

레플리카 구조
- 각 레플리카(파드)는 독립 컨테이너. 자기 server·모델·GPU·메모리를 가짐
- 유일한 공유 지점은 마운트된 작업 폴더(WORK_DIR=/workspace)
- 레플리카 식별 = 파드 이름(hostname)

폴더 역할 분리 (A방식)
- OUTPUT_DIR (/workspace/outputs)       : 보존용. 실제 PNG 전부 쌓임(아카이브)
- CURRENT_DIR (/workspace/current/run_<RUN_ID>) : UI 렌더링용(이번 실행만)
    - <id>.json          : 이미지 메타(프롬프트·seed·replica + 보존 PNG 경로). 가벼움
    - status/<pod>.json  : 레플리카 하트비트(VRAM·RAM·util·생성수·잡상태)
- UI는 CURRENT_DIR만 스캔 → 이전 작업물과 안 섞임. 어느 레플리카가 응답하든 같은 폴더라 일관

이미지 저장: PNG는 OUTPUT_DIR에 1번만(용량 중복 X), 메타 json만 CURRENT_DIR에 → 둘 분리
"""

import os
import json
import time
import socket
import random
import threading
import datetime as dt
from pathlib import Path

import torch
from fastapi import FastAPI, Body, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse

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
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(WORK_DIR / "outputs")))   # 보존(아카이브)
RUN_ID = os.getenv("RUN_ID", "default").strip() or "default"
CURRENT_DIR = WORK_DIR / "current" / f"run_{RUN_ID}"                    # UI 렌더링용
STATUS_DIR = CURRENT_DIR / "status"

REPLICA_ID = socket.gethostname()   # 파드 이름

DEFAULT_WIDTH = int(os.getenv("ZIMG_WIDTH", "1024"))
DEFAULT_HEIGHT = int(os.getenv("ZIMG_HEIGHT", "1024"))
DEFAULT_STEPS = int(os.getenv("ZIMG_STEPS", "8"))
DEFAULT_GUIDANCE = float(os.getenv("ZIMG_GUIDANCE", "0.0"))

GEN_COUNT = os.getenv("GEN_COUNT", "").strip()
CONDITIONS_FILE = os.getenv("CONDITIONS_FILE", "").strip()
RANDOM_PICK = os.getenv("RANDOM_PICK", "false").strip().lower() in ("1", "true", "yes", "y")

VRAM_LIMIT_GB = float(os.getenv("VRAM_LIMIT_GB", "8"))  # 대시보드 빨강 임계값

app = FastAPI(title="zimage-auto-light")
_INDEX_HTML = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")

for d in (OUTPUT_DIR, CURRENT_DIR, STATUS_DIR):
    d.mkdir(parents=True, exist_ok=True)

print(f"[ INFO ] REPLICA(pod) = {REPLICA_ID}", flush=True)
print(f"[ INFO ] RUN_ID = {RUN_ID}", flush=True)
print(f"[ INFO ] OUTPUT_DIR(보존) = {OUTPUT_DIR}", flush=True)
print(f"[ INFO ] CURRENT_DIR(UI)  = {CURRENT_DIR}", flush=True)

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
LAST_GEN = {"seconds": None, "peak_vram_mb": None, "device_used_mb": None}


def _gpu_snapshot():
    """현재 GPU/RAM 스냅샷 (GB)."""
    out = {"vram_used_gb": None, "vram_total_gb": None, "util": None,
           "ram_used_gb": None, "ram_total_gb": None, "ram_percent": None}
    if torch.cuda.is_available():
        free_b, total_b = torch.cuda.mem_get_info()
        out["vram_used_gb"] = round((total_b - free_b) / 1024**3, 2)
        out["vram_total_gb"] = round(total_b / 1024**3, 1)
        if _NVML:
            try:
                h = pynvml.nvmlDeviceGetHandleByIndex(0)
                out["util"] = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
            except Exception:
                pass
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


def _run_generation(prompt, width, height, steps, guidance, seed, source):
    """1장 생성 → PNG는 OUTPUT_DIR(보존), 메타는 CURRENT_DIR(UI). gpu_lock 안에서 호출."""
    global MY_GENERATED
    if seed is None:
        seed = random.randint(0, 2**32 - 1)
    generator = torch.Generator().manual_seed(int(seed))

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    t0 = time.time()

    image: Image.Image = pipe(
        prompt=prompt, width=width, height=height,
        num_inference_steps=steps, guidance_scale=guidance, generator=generator,
    ).images[0]

    elapsed = time.time() - t0
    if torch.cuda.is_available():
        LAST_GEN["seconds"] = round(elapsed, 2)
        LAST_GEN["peak_vram_mb"] = round(torch.cuda.max_memory_allocated() / 1024**2, 1)
        free_b, total_b = torch.cuda.mem_get_info()
        LAST_GEN["device_used_mb"] = round((total_b - free_b) / 1024**2, 1)

    seq = _next_seq()
    ts = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = f"{REPLICA_ID}_{ts}_{seq:05d}_seed{seed}"

    # PNG → 보존 폴더에만
    png_path = OUTPUT_DIR / f"{stem}.png"
    image.save(png_path, format="PNG")

    # 메타 → UI 폴더 (가벼움, 실제 PNG 경로 포함)
    meta = {
        "id": stem,
        "png": str(png_path),
        "replica": REPLICA_ID,
        "prompt": prompt, "seed": int(seed),
        "width": width, "height": height, "steps": steps, "guidance": guidance,
        "source": source,
        "created": dt.datetime.now().isoformat(timespec="seconds"),
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
        self._cancel = threading.Event()
        self._resume = threading.Event()
        self._thread = None

    def status(self):
        return {"state": self.state, "total": self.total, "completed": self.completed,
                "message": self.message, "busy": self.state in ("running", "paused")}

    def start(self, conditions, count, random_pick):
        if self.state in ("running", "paused"):
            raise HTTPException(409, "이미 작업이 진행 중입니다.")
        if not isinstance(conditions, list) or not conditions:
            raise HTTPException(400, "조건 목록이 비어 있습니다.")
        self.state = "running"; self.total = int(count); self.completed = 0; self.message = ""
        self._cancel.clear(); self._resume.set()
        self._thread = threading.Thread(target=self._worker,
                                        args=(conditions, int(count), bool(random_pick)), daemon=True)
        self._thread.start()

    def _pick(self, conds, idx, rnd):
        return random.choice(conds) if rnd else conds[idx % len(conds)]

    def _worker(self, conds, count, rnd):
        try:
            for i in range(count):
                if self._cancel.is_set():
                    self.state = "cancelled"; self.message = f"{self.completed}장 후 취소"; return
                self._resume.wait()
                if self._cancel.is_set():
                    self.state = "cancelled"; self.message = f"{self.completed}장 후 취소"; return
                c = self._pick(conds, i, rnd)
                with gpu_lock:
                    _run_generation(c.get("prompt", ""), int(c.get("width", DEFAULT_WIDTH)),
                                    int(c.get("height", DEFAULT_HEIGHT)), int(c.get("steps", DEFAULT_STEPS)),
                                    float(c.get("guidance", DEFAULT_GUIDANCE)), c.get("seed"), "auto")
                self.completed += 1
            self.state = "done"; self.message = f"{self.completed}장 완료"
        except Exception as e:
            self.state = "error"; self.message = str(e)

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
        raise HTTPException(400, f"설정값 파일을 찾을 수 없습니다: {p}")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(data, list) and data
        return data
    except Exception as e:
        raise HTTPException(400, f"설정값 파일 파싱 실패: {e}")


# ─────────────────────────────────────────────────────────────
# 하트비트: status/<pod>.json 주기적 기록
# ─────────────────────────────────────────────────────────────
def _write_heartbeat():
    snap = _gpu_snapshot()
    js = job.status()
    peak_gb = round(LAST_GEN["peak_vram_mb"] / 1024, 2) if LAST_GEN["peak_vram_mb"] else None
    data = {
        "replica": REPLICA_ID,
        "updated": dt.datetime.now().isoformat(timespec="seconds"),
        "vram_used_gb": snap["vram_used_gb"],
        "vram_total_gb": snap["vram_total_gb"],
        "vram_peak_gb": peak_gb,          # 최근 생성 peak (8GB 판단 기준)
        "ram_used_gb": snap["ram_used_gb"],
        "ram_total_gb": snap["ram_total_gb"],
        "util": snap["util"],
        "generated": MY_GENERATED,
        "last_gen_s": LAST_GEN["seconds"],
        "job_state": js["state"],
        "job_total": js["total"],
        "job_completed": js["completed"],
        "vram_limit_gb": VRAM_LIMIT_GB,
    }
    try:
        (STATUS_DIR / f"{REPLICA_ID}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[ WARN ] 하트비트 실패: {e}", flush=True)


def _heartbeat_loop():
    while True:
        _write_heartbeat()
        time.sleep(3)


# ─────────────────────────────────────────────────────────────
# 기동
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
def _startup():
    threading.Thread(target=_heartbeat_loop, daemon=True).start()
    _write_heartbeat()
    if GEN_COUNT and CONDITIONS_FILE:
        try:
            conds = _load_conditions_file(CONDITIONS_FILE)
            job.start(conds, int(GEN_COUNT), RANDOM_PICK)
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
        raise HTTPException(409, "작업 중에는 수동 생성을 할 수 없습니다.")
    cond = {"prompt": prompt, "width": width, "height": height,
            "steps": num_inference_steps, "guidance": guidance_scale, "seed": seed}
    if count and count > 1:
        job.start([cond], int(count), random_pick=False)
        return JSONResponse({"mode": "job", "status": job.status()})
    with gpu_lock:
        meta = _run_generation(prompt, width, height, num_inference_steps, guidance_scale, seed, "manual")
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
    job.start(_load_conditions_file(f), c, r)
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


@app.get("/api/resources")
def resources():
    """이 레플리카의 실시간 자원 + 최근 생성 기록."""
    snap = _gpu_snapshot()
    return {"replica": REPLICA_ID, "gpu": snap, "last_gen": LAST_GEN, "vram_limit_gb": VRAM_LIMIT_GB}


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
    return {"repo": repo, "name": base, "dtype": dtype, "run_id": RUN_ID}


@app.get("/api/replicas")
def list_replicas():
    """CURRENT_DIR/status 스캔 → 모든 레플리카 현황 (대시보드용)."""
    reps = []
    try:
        for p in STATUS_DIR.glob("*.json"):
            try:
                reps.append(json.loads(p.read_text(encoding="utf-8")))
            except Exception:
                continue
    except Exception:
        pass
    reps.sort(key=lambda r: r.get("replica", ""))
    # 합산
    total_gen = sum(r.get("generated", 0) or 0 for r in reps)
    running = [r for r in reps if r.get("job_state") == "running"]
    utils = [r.get("util") for r in reps if r.get("util") is not None]
    summary = {
        "replicas": len(reps),
        "total_generated": total_gen,
        "running": len(running),
        "avg_util": round(sum(utils) / len(utils)) if utils else None,
    }
    return {"run_id": RUN_ID, "summary": summary, "replicas": reps}


@app.get("/api/images")
def list_images(replica: str = None, limit: int = 500):
    """CURRENT_DIR의 메타 json 스캔 → 이번 실행 이미지 목록 (최근순). replica 필터 옵션."""
    metas = []
    try:
        files = sorted(CURRENT_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files:
            if len(metas) >= limit:
                break
            try:
                m = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if replica and m.get("replica") != replica:
                continue
            metas.append(m)
    except Exception:
        pass
    return metas


@app.get("/api/images/{image_id}/file")
def image_file(image_id: str):
    """보존 폴더(OUTPUT_DIR)의 실제 PNG 서빙. 어느 레플리카든 공유 폴더라 서빙 가능."""
    path = OUTPUT_DIR / f"{image_id}.png"
    if not path.exists():
        raise HTTPException(404, "파일이 없습니다.")
    return FileResponse(path, media_type="image/png")