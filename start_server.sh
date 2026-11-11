#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

MODEL="${WHISPER_MODEL:-small}"
PORT="${PORT:-8765}"

echo "===================================================="
echo " 🎙️ dアニメ AIリアルタイム字幕サーバー (Faster-Whisper)"
echo "  モデル: ${MODEL} (変更例: WHISPER_MODEL=large-v3-turbo ./start_server.sh)"
echo "  URL   : http://127.0.0.1:${PORT}"
echo "===================================================="

if command -v uv >/dev/null 2>&1; then
  exec uv run --with faster-whisper --with numpy --with nvidia-cublas-cu12 --with nvidia-cudnn-cu12 \
    python3 server/whisper_server.py --model "${MODEL}" --port "${PORT}" "$@"
else
  exec python3 server/whisper_server.py --model "${MODEL}" --port "${PORT}" "$@"
fi
