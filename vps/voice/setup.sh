#!/usr/bin/env bash
# NovaBot's voice on the VPS (vps/voice/server.py): Python, Piper (text to speech, a British
# voice), faster-whisper (speech to text) and their models, in /srv/nova/voice. Safe to run again.
# Run on the VPS as root (vps/deploy.sh runs it when the models aren't there yet).
set -euo pipefail
D=/srv/nova/voice
apt-get install -y -qq python3-venv >/dev/null
mkdir -p "$D/models"
[ -x "$D/venv/bin/python" ] || python3 -m venv "$D/venv"
"$D/venv/bin/pip" install -q --upgrade pip
"$D/venv/bin/pip" install -q piper-tts faster-whisper numpy
cd "$D/models"
[ -s en_GB-jenny_dioco-medium.onnx ] || "$D/venv/bin/python" -m piper.download_voices en_GB-jenny_dioco-medium
"$D/venv/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8', download_root='$D/models/whisper')"
chown -R nova:nova "$D"
echo "NovaBot's voice: ready in $D"
