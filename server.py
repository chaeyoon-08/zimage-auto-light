"""
zimage-auto-light — Z-Image-Turbo 자동 이미지 생성 REST API

동작 요약
- GPU 1장 → 모든 생성은 gpu_lock으로 직렬화 (동시 충돌 방지)
- 수동 생성: 개수=1 즉시 1장(base64), 개수>1 이면 배치 잡으로 전환
- 자동화 잡(③): 환경변수(GEN_COUNT 등) 있으면 기동 시 자동 시작
  - 설정값 배열 파일을 순차(초과 시 처음부터 반복) 또는 랜덤으로 N장 생성
- 잡 일시중지/재개/취소, 취소 시 진행분(이미 저장된 것)은 유지
- 잡이 살아있는 동안(진행/일시중지) HTML 수동 생성 잠금
- 모든 생성 이미지는 생성 즉시 OUTPUT_DIR에 저장
- 리소스 모니터링: /api/resources (VRAM·RAM·GPU사용률·장당시간)
"""

import os
import json
import time
import base64
import random
import threading
import datetime as dt
from io import BytesIO
from pathlib import Path

import torch
from fastapi import FastAPI, Body, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse

# sdnq를 import 해야 diffusers/transformers에 SDNQ 양자화 로더가 등록됨 (로드 전 필수)
from sdnq import SDNQConfig  # noqa: F401
from diffusers import ZImagePipeline
from PIL import Image

# 선택적 모니터링 라이브러리 (없거나 실패해도 동작에 지장 없게 가드)
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
# 설정
# ─────────────────────────────────────────────────────────────
MODEL_REPO = os.getenv("MODEL_REPO", "Disty0/Z-Image-Turbo-SDNQ-uint4-svd-r32")
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/workspace/outputs"))
WORK_DIR = Path(os.getenv("WORK_DIR", "/workspace"))
DEFAULT_WIDTH = int(os.getenv("ZIMG_WIDTH", "1024"))
DEFAULT_HEIGHT = int(os.getenv("ZIMG_HEIGHT", "1024"))
DEFAULT_STEPS = int(os.getenv("ZIMG_STEPS", "8"))
DEFAULT_GUIDANCE = float(os.getenv("ZIMG_GUIDANCE", "0.0"))

# 사용자 입력 환경변수 (없으면 자동화 꺼짐 = 수동 모드)
GEN_COUNT = os.getenv("GEN_COUNT", "").strip()
CONDITIONS_FILE = os.getenv("CONDITIONS_FILE", "").strip()
RANDOM_PICK = os.getenv("RANDOM_PICK", "false").strip().lower() in ("1", "true", "yes", "y")

app = FastAPI(title="zimage-auto-light")
_INDEX_HTML = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")

# ─────────────────────────────────────────────────────────────
# 모델 로드 (안정 우선: quantized matmul / torch.compile 미사용, cpu offload)
# ─────────────────────────────────────────────────────────────
print(f"[ MODEL ] loading {MODEL_REPO} ...", flush=True)
pipe = ZImagePipeline.from_pretrained(MODEL_REPO, torch_dtype=torch.bfloat16)
pipe.enable_model_cpu_offload()
print("[ MODEL ] ready", flush=True)

# ─────────────────────────────────────────────────────────────
# 공유 상태
# ─────────────────────────────────────────────────────────────
gpu_lock = threading.Lock()
IMAGES = []
IMAGES_LOCK = threading.Lock()
_seq = 0
LAST_GEN = {"seconds": None, "peak_vram_mb": None, "device_used_mb": None}


def _next_filename(seed: int) -> str:
    global _seq
    _seq += 1
    ts = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{ts}_{_seq:05d}_seed{seed}.png"


def _run_generation(prompt, width, height, steps, guidance, seed, source):
    """실제 1장 생성 + 즉시 저장 + 리소스 peak 기록. gpu_lock 안에서만 호출."""
    if seed is None:
        seed = random.randint(0, 2**32 - 1)
    generator = torch.Generator().manual_seed(int(seed))

    # 생성 구간 VRAM peak 측정
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    t0 = time.time()

    image: Image.Image = pipe(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    ).images[0]

    elapsed = time.time() - t0
    if torch.cuda.is_available():
        LAST_GEN["seconds"] = round(elapsed, 2)
        LAST_GEN["peak_vram_mb"] = round(torch.cuda.max_memory_allocated() / 1024**2, 1)
        free_b, total_b = torch.cuda.mem_get_info()
        LAST_GEN["device_used_mb"] = round((total_b - free_b) / 1024**2, 1)

    filename = _next_filename(seed)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / filename
    image.save(path, format="PNG")

    buf = BytesIO()
    image.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

    meta = {
        "id": _seq,
        "filename": filename,
        "prompt": prompt,
        "seed": int(seed),
        "width": width,
        "height": height,
        "steps": steps,
        "guidance": guidance,
        "source": source,
        "created": dt.datetime.now().isoformat(timespec="seconds"),
    }
    with IMAGES_LOCK:
        IMAGES.append(meta)
    return meta, b64


# ─────────────────────────────────────────────────────────────
# 자동화/배치 잡 (일시중지 / 재개 / 취소)
# ─────────────────────────────────────────────────────────────
class JobManager:
    def __init__(self):
        self.state = "idle"      # idle | running | paused | cancelled | done | error
        self.total = 0
        self.completed = 0
        self.message = ""
        self._cancel = threading.Event()
        self._resume = threading.Event()
        self._thread = None

    def status(self):
        return {
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "message": self.message,
            "busy": self.state in ("running", "paused"),
        }

    def start(self, conditions, count, random_pick):
        if self.state in ("running", "paused"):
            raise HTTPException(409, "이미 작업이 진행 중입니다.")
        if not isinstance(conditions, list) or len(conditions) == 0:
            raise HTTPException(400, "조건 목록이 비어 있습니다.")
        self.state = "running"
        self.total = int(count)
        self.completed = 0
        self.message = ""
        self._cancel.clear()
        self._resume.set()
        self._thread = threading.Thread(
            target=self._worker, args=(conditions, int(count), bool(random_pick)), daemon=True
        )
        self._thread.start()

    def _pick(self, conditions, idx, random_pick):
        if random_pick:
            return random.choice(conditions)        # 랜덤(중복 허용)
        return conditions[idx % len(conditions)]    # 순차(초과 시 처음부터 반복)

    def _worker(self, conditions, count, random_pick):
        try:
            for i in range(count):
                if self._cancel.is_set():
                    self.state = "cancelled"
                    self.message = f"{self.completed}장 생성 후 취소됨"
                    return
                self._resume.wait()
                if self._cancel.is_set():
                    self.state = "cancelled"
                    self.message = f"{self.completed}장 생성 후 취소됨"
                    return
                c = self._pick(conditions, i, random_pick)
                with gpu_lock:
                    _run_generation(
                        prompt=c.get("prompt", ""),
                        width=int(c.get("width", DEFAULT_WIDTH)),
                        height=int(c.get("height", DEFAULT_HEIGHT)),
                        steps=int(c.get("steps", DEFAULT_STEPS)),
                        guidance=float(c.get("guidance", DEFAULT_GUIDANCE)),
                        seed=c.get("seed"),
                        source="auto",
                    )
                self.completed += 1
            self.state = "done"
            self.message = f"{self.completed}장 생성 완료"
        except Exception as e:
            self.state = "error"
            self.message = str(e)

    def pause(self):
        if self.state == "running":
            self._resume.clear()
            self.state = "paused"

    def resume(self):
        if self.state == "paused":
            self._resume.set()
            self.state = "running"

    def cancel(self):
        if self.state in ("running", "paused"):
            self._cancel.set()
            self._resume.set()


job = JobManager()


def _load_conditions_file(name):
    cpath = Path(name)
    if not cpath.is_absolute():
        cpath = WORK_DIR / name
    if not cpath.exists():
        raise HTTPException(400, f"설정값 파일을 찾을 수 없습니다: {cpath}")
    try:
        data = json.loads(cpath.read_text(encoding="utf-8"))
        assert isinstance(data, list) and len(data) > 0
        return data
    except Exception as e:
        raise HTTPException(400, f"설정값 파일 파싱 실패: {e}")


# ─────────────────────────────────────────────────────────────
# 기동 시 자동화 환경변수가 있으면 자동 시작
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
def _maybe_autostart():
    if GEN_COUNT and CONDITIONS_FILE:
        try:
            conds = _load_conditions_file(CONDITIONS_FILE)
            job.start(conds, int(GEN_COUNT), RANDOM_PICK)
            print(f"[ AUTO  ] 자동화 시작: {GEN_COUNT}장 / {CONDITIONS_FILE} / random={RANDOM_PICK}", flush=True)
        except Exception as e:
            print(f"[ AUTO  ] 자동화 시작 실패: {e}", flush=True)
    else:
        print("[ AUTO  ] 수동 모드 (자동화 환경변수 없음)", flush=True)


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

    cond = {
        "prompt": prompt, "width": width, "height": height,
        "steps": num_inference_steps, "guidance": guidance_scale, "seed": seed,
    }

    # 개수>1 → 배치 잡으로 전환 (같은 프롬프트, seed 미지정이면 매번 랜덤 → 다양한 결과)
    if count and count > 1:
        job.start([cond], int(count), random_pick=False)
        return JSONResponse({"mode": "job", "status": job.status()})

    # 개수=1 → 즉시 1장
    with gpu_lock:
        meta, b64 = _run_generation(
            prompt, width, height, num_inference_steps, guidance_scale, seed, "manual"
        )
    return JSONResponse({"mode": "single", "image_base64": b64, "meta": meta})


@app.get("/api/status")
def status():
    return job.status()


@app.post("/api/job/start")
def job_start(
    count: int = Body(None),
    conditions_file: str = Body(None),
    random_pick: bool = Body(None),
):
    c = count if count is not None else (int(GEN_COUNT) if GEN_COUNT else 0)
    f = conditions_file if conditions_file is not None else CONDITIONS_FILE
    r = random_pick if random_pick is not None else RANDOM_PICK
    if not c or not f:
        raise HTTPException(400, "count 와 conditions_file 이 필요합니다.")
    conds = _load_conditions_file(f)
    job.start(conds, c, r)
    return job.status()


@app.post("/api/job/pause")
def job_pause():
    job.pause()
    return job.status()


@app.post("/api/job/resume")
def job_resume():
    job.resume()
    return job.status()


@app.post("/api/job/cancel")
def job_cancel():
    job.cancel()
    return job.status()


@app.get("/api/resources")
def resources():
    out = {"gpu": None, "ram": None, "last_gen": LAST_GEN}
    # GPU VRAM (torch)
    if torch.cuda.is_available():
        free_b, total_b = torch.cuda.mem_get_info()
        gpu = {
            "vram_used_mb": round((total_b - free_b) / 1024**2, 1),
            "vram_total_mb": round(total_b / 1024**2, 1),
            "util_percent": None,
        }
        if _NVML:
            try:
                h = pynvml.nvmlDeviceGetHandleByIndex(0)
                gpu["util_percent"] = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
            except Exception:
                pass
        out["gpu"] = gpu
    # 시스템 RAM
    if psutil is not None:
        vm = psutil.virtual_memory()
        out["ram"] = {
            "used_mb": round(vm.used / 1024**2, 1),
            "total_mb": round(vm.total / 1024**2, 1),
            "percent": vm.percent,
        }
    return out


@app.get("/api/model")
def model_info():
    repo = MODEL_REPO
    base = repo.split("/")[-1].split("-SDNQ")[0]   # 예: "Z-Image-Turbo"
    low = repo.lower()
    dtype = next((d for d in ("uint4", "int8", "int4", "uint8", "fp8") if d in low), "?")
    return {"repo": repo, "name": base, "dtype": dtype}


@app.get("/api/images")
def list_images():
    with IMAGES_LOCK:
        return list(reversed(IMAGES))


@app.get("/api/images/{image_id}/file")
def image_file(image_id: int):
    with IMAGES_LOCK:
        meta = next((m for m in IMAGES if m["id"] == image_id), None)
    if not meta:
        raise HTTPException(404, "이미지를 찾을 수 없습니다.")
    path = OUTPUT_DIR / meta["filename"]
    if not path.exists():
        raise HTTPException(404, "파일이 없습니다.")
    return FileResponse(path, media_type="image/png")