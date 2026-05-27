#!/usr/bin/env bash
set -euo pipefail

echo "[ START ] zimage-auto-light"
echo "[ INFO  ] MODEL_REPO = ${MODEL_REPO}"
echo "[ INFO  ] OUTPUT_DIR = ${OUTPUT_DIR}"

# 사용자 입력 환경변수 유무로 모드 안내 (실제 자동화 시작은 server.py startup에서 처리)
if [ -n "${GEN_COUNT:-}" ] && [ -n "${CONDITIONS_FILE:-}" ]; then
    echo "[ INFO  ] 자동화 모드: GEN_COUNT=${GEN_COUNT}, CONDITIONS_FILE=${CONDITIONS_FILE}, RANDOM_PICK=${RANDOM_PICK:-false}"
else
    echo "[ INFO  ] 수동 모드 (자동화 환경변수 없음) — HTML 접속해서 생성"
fi

cd /app
exec python3 -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-8000}"
