#!/usr/bin/env python3
"""
Local Real-Time GPU Whisper Subtitle Server for d-anime Subtitle Assistant.
- Captures desktop playback audio directly from PipeWire/PulseAudio monitor source
  (works even on DRM/Widevine encrypted streams like d-anime store!).
- Also accepts base64 audio chunks via POST /transcribe if sent by the browser.
- Runs faster-whisper on NVIDIA GPU (float16) with VAD filtering to avoid hallucinations during BGM/silence.
"""

import argparse
import base64
import collections
import io
import json
import logging
import os
import subprocess
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

import numpy as np
from faster_whisper import WhisperModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("danime-whisper")

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2  # int16 mono

# Common Whisper hallucinations during anime BGM / silence
HALLUCINATION_PHRASES = {
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございました。",
    "チャンネル登録よろしくお願いします",
    "チャンネル登録をお願いいたします",
    "字幕由Amara.org社区提供",
    "おやすみなさい",
    "ありがとうございました",
    "ありがとうございました。",
    "Thank you for watching.",
    "Subtitles by",
}


class SystemAudioRingBuffer:
    """Continuously captures 16kHz mono PCM from the default PulseAudio/PipeWire sink monitor."""

    def __init__(self, max_seconds: float = 12.0):
        self.max_samples = int(SAMPLE_RATE * max_seconds)
        self.buffer = collections.deque(maxlen=self.max_samples)
        self.lock = threading.Lock()
        self.proc: Optional[subprocess.Popen] = None
        self.running = False
        self.monitor_source = self._detect_monitor_source()

    def _detect_monitor_source(self) -> str:
        try:
            sink = subprocess.check_output(
                ["pactl", "get-default-sink"], text=True
            ).strip()
            if sink:
                return f"{sink}.monitor"
        except Exception as e:
            logger.warning(f"Failed to get default sink via pactl: {e}")
        return "@DEFAULT_MONITOR@"

    def start(self):
        if self.running:
            return
        self.running = True
        self.monitor_source = self._detect_monitor_source()
        logger.info(f"Starting system audio capture from: {self.monitor_source}")
        thread = threading.Thread(target=self._reader_loop, daemon=True)
        thread.start()

    def _reader_loop(self):
        cmd = [
            "parec",
            f"--device={self.monitor_source}",
            "--format=s16le",
            f"--rate={SAMPLE_RATE}",
            "--channels=1",
            "--latency-msec=50",
        ]
        while self.running:
            try:
                self.proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
                )
                chunk_bytes = SAMPLE_RATE * BYTES_PER_SAMPLE // 10  # 100ms chunks
                while self.running and self.proc.poll() is None:
                    data = self.proc.stdout.read(chunk_bytes)
                    if not data:
                        break
                    samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                    with self.lock:
                        self.buffer.extend(samples)
            except Exception as e:
                logger.error(f"Audio capture error: {e}")
                time.sleep(1.0)

    def get_recent_audio(self, seconds: float = 3.2) -> np.ndarray:
        num_samples = int(SAMPLE_RATE * seconds)
        with self.lock:
            if not self.buffer:
                return np.zeros(0, dtype=np.float32)
            arr = np.array(self.buffer, dtype=np.float32)
        if len(arr) > num_samples:
            return arr[-num_samples:]
        return arr


class WhisperEngine:
    def __init__(self, model_size: str = "small", device: str = "auto"):
        logger.info(f"Loading faster-whisper model '{model_size}' (device={device})...")
        try:
            self.model = WhisperModel(
                model_size,
                device=device,
                compute_type="float16" if device != "cpu" else "int8",
            )
            self.device = device
        except Exception as e:
            logger.warning(f"CUDA float16 load failed ({e}), falling back to CPU int8...")
            self.model = WhisperModel(model_size, device="cpu", compute_type="int8")
            self.device = "cpu"
        self.model_size = model_size
        self.lock = threading.Lock()
        self.last_text = ""
        logger.info("Whisper model ready!")

    def transcribe(
        self, audio: np.ndarray, language: str = "ja", initial_prompt: str = ""
    ) -> str:
        if len(audio) < SAMPLE_RATE * 0.4:
            return ""

        # Check RMS energy to skip pure silence
        rms = float(np.sqrt(np.mean(audio**2)))
        if rms < 0.003:
            return ""

        with self.lock:
            segments, _ = self.model.transcribe(
                audio,
                language=language,
                initial_prompt=initial_prompt or "アニメの日本語のセリフ。",
                beam_size=2,
                best_of=2,
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=250,
                    speech_pad_ms=150,
                ),
                condition_on_previous_text=False,
                temperature=0.0,
            )
            texts = []
            for seg in segments:
                t = seg.text.strip()
                if not t or t in HALLUCINATION_PHRASES:
                    continue
                if seg.no_speech_prob > 0.65:
                    continue
                texts.append(t)

            result = " ".join(texts).strip()
            if result == self.last_text:
                return result
            self.last_text = result
            return result


audio_buffer: Optional[SystemAudioRingBuffer] = None
whisper_engine: Optional[WhisperEngine] = None


class SubtitleRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress noisy per-request logs
        pass

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            payload = {
                "status": "ok",
                "model": whisper_engine.model_size if whisper_engine else "none",
                "monitor": audio_buffer.monitor_source if audio_buffer else "none",
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except Exception:
            body = {}

        language = body.get("language", "ja")
        prompt = body.get("initial_prompt", "")
        b64 = body.get("audio_base64")

        if b64:
            wav_bytes = base64.b64decode(b64)
            with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
                frames = wf.readframes(wf.getnframes())
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        else:
            audio = audio_buffer.get_recent_audio(seconds=3.2)

        t0 = time.time()
        text = whisper_engine.transcribe(audio, language=language, initial_prompt=prompt)
        elapsed_ms = int((time.time() - t0) * 1000)
        if text:
            logger.info(f"[{elapsed_ms}ms] {text}")

        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({"text": text, "latency_ms": elapsed_ms}, ensure_ascii=False).encode(
                "utf-8"
            )
        )


def main():
    global audio_buffer, whisper_engine
    parser = argparse.ArgumentParser(description="d-anime Real-Time GPU Whisper Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host address")
    parser.add_argument("--port", type=int, default=8765, help="Port number")
    parser.add_argument(
        "--model",
        default=os.environ.get("WHISPER_MODEL", "small"),
        help="Whisper model size (tiny, base, small, medium, large-v3-turbo)",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="Compute device (auto, cuda, cpu)",
    )
    args = parser.parse_args()

    audio_buffer = SystemAudioRingBuffer(max_seconds=12.0)
    audio_buffer.start()

    whisper_engine = WhisperEngine(model_size=args.model, device=args.device)

    server = ThreadingHTTPServer((args.host, args.port), SubtitleRequestHandler)
    logger.info(f"Listening on http://{args.host}:{args.port} (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server...")


if __name__ == "__main__":
    main()
