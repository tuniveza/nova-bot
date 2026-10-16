"""NovaBot's voice on the VPS: speech to text and text to speech, on the server itself.

On Cloudflare, NovaBot's /speak and /listen used Workers AI; on the VPS there is none, so they
use this instead (Nova Bot's src/index.js, when VOICE_URL and VOICE_KEY are set):

  POST /speak   {"text": "..."}          -> audio/wav: a natural British woman's voice (Piper,
                                            en_GB-jenny_dioco-medium), calm and unhurried
  POST /listen  (audio/wav, 16 kHz mono) -> {"text": "..."}: what was said (Whisper base.en,
                                            faster-whisper, int8 on the CPU)
  GET  /health                           -> {"ok": true}

Only on 127.0.0.1 (Nova Bot is the only caller), with the key in /srv/nova/voice.env
(VOICE_KEY, VOICE_PORT). Nothing is saved: the audio and the words stay in memory for the one
request. Installed by vps/deploy.sh; the models are in /srv/nova/voice/models (vps/voice/setup.sh).
"""

import hmac
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from faster_whisper import WhisperModel
from piper import PiperVoice, SynthesisConfig

HERE = os.environ.get("VOICE_DIR", "/srv/nova/voice")
KEY = os.environ.get("VOICE_KEY", "")
PORT = int(os.environ.get("VOICE_PORT", "8791"))
VOICE = os.environ.get("VOICE_MODEL", "en_GB-jenny_dioco-medium")
MAX_AUDIO = 1_500_000  # about a minute of 16 kHz speech
MAX_TEXT = 600

speaker = PiperVoice.load(os.path.join(HERE, "models", VOICE + ".onnx"))
# Calm: a touch slower than normal, natural variation kept
STYLE = SynthesisConfig(length_scale=1.08, noise_scale=0.62, noise_w_scale=0.8)
listener = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=2, download_root=os.path.join(HERE, "models", "whisper"))
PROMPT = "A customer talking to NovaBot at Novacane recording studio in Forest Hill, London, about sessions, prices, mixing and booking."
speak_lock = threading.Lock()
listen_lock = threading.Lock()


def speak(text: str) -> bytes:
    buf = io.BytesIO()
    with speak_lock, wave.open(buf, "wb") as wav:
        speaker.synthesize_wav(text, wav, syn_config=STYLE)
    return buf.getvalue()


def samples(audio: bytes) -> np.ndarray:
    """The widget sends 16 kHz mono 16-bit WAV (its toWav): read it straight into what Whisper wants."""
    with wave.open(io.BytesIO(audio), "rb") as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1 or wav.getframerate() != 16000:
            raise ValueError("Not 16 kHz mono 16-bit WAV")
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def listen(audio: bytes) -> str:
    pcm = samples(audio)
    with listen_lock:
        segments, _ = listener.transcribe(pcm, language="en", vad_filter=True, beam_size=1, initial_prompt=PROMPT)
        return " ".join(s.text.strip() for s in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # (no logs: nothing anyone said is written down)
        pass

    def answer(self, status: int, body: bytes, kind: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def said(self, status: int, data: dict):
        self.answer(status, json.dumps(data).encode())

    def do_GET(self):
        if self.path == "/health":
            return self.said(200, {"ok": True})
        self.said(404, {"error": "Not found"})

    def do_POST(self):
        if not KEY or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + KEY):
            return self.said(401, {"error": "Not allowed"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_AUDIO:
            return self.said(413 if size else 400, {"error": "Too long" if size else "Nothing sent"})
        body = self.rfile.read(size)
        try:
            if self.path == "/speak":
                text = str(json.loads(body).get("text", "")).strip()[:MAX_TEXT]
                if not text:
                    return self.said(400, {"error": "No text"})
                return self.answer(200, speak(text), "audio/wav")
            if self.path == "/listen":
                return self.said(200, {"text": listen(body)})
        except Exception as err:  # (never the words or audio, only what went wrong)
            return self.said(500, {"error": type(err).__name__})
        self.said(404, {"error": "Not found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
