# zimage-auto-light — Z-Image-Turbo 자동 이미지 생성 REST API (gcube 워크로드용)
# 베이스: CUDA 12.8 + cuDNN runtime (Ubuntu 22.04)
#   - 지시받은 CUDA 12.8 기준
#   - RTX 5060(Blackwell)은 CUDA 12.8+ 필요 → 충족
#   - runtime 선택: 모든 의존성이 prebuilt 휠, 빌드/런타임 컴파일 경로 안 탐 → 경량
FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

# ── 빌드 인자: 구울 모델(dtype). build.yml에서 uint4 / int8 로 교체 ──
ARG MODEL_REPO=Disty0/Z-Image-Turbo-SDNQ-uint4-svd-r32

LABEL maintainer="data-alliance" \
      purpose="z-image-turbo auto image generation REST API for gcube" \
      model="${MODEL_REPO}"

# ── 환경 변수 (이미지 내부 고정) ──
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_CACHE=/app/hf-cache \
    MODEL_REPO=${MODEL_REPO} \
    OUTPUT_DIR=/workspace/outputs \
    PORT=8000 \
    ZIMG_WIDTH=1024 \
    ZIMG_HEIGHT=1024 \
    ZIMG_STEPS=8 \
    ZIMG_GUIDANCE=0.0

# ── 시스템 패키지 ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip git wget curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── pip 업그레이드 ──
RUN python3 -m pip install --upgrade pip setuptools wheel

# ── 의존성 설치 + diffusers 소스 설치 ──
COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install -r /app/requirements.txt
RUN python3 -m pip install --no-deps git+https://github.com/huggingface/diffusers

# ── PyTorch를 cu128(CUDA 12.8) 빌드로 교체 (Blackwell 지원) ──
RUN python3 -m pip uninstall -y torch torchvision torchaudio && \
    python3 -m pip install torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cu128

# ── 모델을 빌드 단계에서 이미지에 굽기 ──
#   Tier3는 배포 후 런타임 다운로드 불가 → 빌드 때 HF 캐시에 미리 받아둠
RUN mkdir -p ${HF_HUB_CACHE} ${OUTPUT_DIR} && \
    hf download ${MODEL_REPO}

# ── 런타임은 네트워크 없이 캐시에서 로드 (모델 다운로드 발생 X) ──
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

# ── 애플리케이션 파일 ──
COPY server.py /app/server.py
COPY index.html /app/index.html
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]