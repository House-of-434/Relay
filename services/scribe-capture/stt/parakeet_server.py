"""Parakeet TDT 0.6B int8 STT server (sherpa-onnx).

The Scribe worker POSTs 16 kHz mono WAV to /transcribe and gets text back. One
process serves all captures; the model is loaded once. This is the shared STT
server from plans/scribe-stt.md §6.6 — swap the checkpoint here to change the
model without touching the worker (the worker only speaks the HTTP contract).

Env:
  RELAY_STT_MODEL_DIR   dir holding encoder.int8.onnx, decoder.int8.onnx,
                        joiner.int8.onnx, tokens.txt   (default: ./parakeet)
  RELAY_STT_HOST        default 127.0.0.1
  RELAY_STT_PORT        default 8090

Run:  python3 parakeet_server.py
"""
import io
import json
import os
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

MODEL_DIR = os.environ.get("RELAY_STT_MODEL_DIR", os.path.join(os.path.dirname(__file__), "parakeet"))
HOST = os.environ.get("RELAY_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("RELAY_STT_PORT", "8090"))

REC = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=os.path.join(MODEL_DIR, "encoder.int8.onnx"),
    decoder=os.path.join(MODEL_DIR, "decoder.int8.onnx"),
    joiner=os.path.join(MODEL_DIR, "joiner.int8.onnx"),
    tokens=os.path.join(MODEL_DIR, "tokens.txt"),
    num_threads=int(os.environ.get("RELAY_STT_THREADS", "2")),
    sample_rate=16000,
    feature_dim=80,
    decoding_method="greedy_search",
    model_type="nemo_transducer",
)


def wav_to_float(buf: bytes):
    with wave.open(io.BytesIO(buf), "rb") as w:
        assert w.getframerate() == 16000, w.getframerate()
        assert w.getnchannels() == 1, w.getnchannels()
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json(200, {"status": "ok"}) if self.path == "/health" else self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        try:
            t0 = time.time()
            samples = wav_to_float(raw)
            stream = REC.create_stream()
            stream.accept_waveform(16000, samples)
            REC.decode_stream(stream)
            self._json(200, {
                "text": stream.result.text,
                "audio_seconds": round(len(samples) / 16000, 3),
                "decode_ms": int((time.time() - t0) * 1000),
            })
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": str(exc)[:300]})


if __name__ == "__main__":
    print(f"[relay-stt] {HOST}:{PORT} model={MODEL_DIR}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
