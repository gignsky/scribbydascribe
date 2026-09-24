#!/usr/bin/env python3
"""faster-whisper worker for scrivener.

Reads one JSON job per line on stdin ({"id": n, "path": "clip.wav"}) and
writes one JSON result per line on stdout. The model is loaded once. Logs go
to stderr so stdout stays a clean protocol channel.
"""

import json
import os
import sys

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en") or None
THREADS = int(os.environ.get("WHISPER_THREADS", "0") or 0)

# Segments Whisper itself doubts are dropped: these are where it invents
# "Thank you." or subtitle credits out of breath noise.
MAX_NO_SPEECH = 0.6
MIN_LOGPROB = -1.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(*args):
    print("[worker]", *args, file=sys.stderr, flush=True)


def main():
    log(f"loading model {MODEL} ({DEVICE}/{COMPUTE})")
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS)
    emit({"ready": True, "model": MODEL, "device": DEVICE})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        try:
            segments, info = model.transcribe(
                job["path"],
                language=LANGUAGE,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                # Each clip is one speaker's turn; carrying context between
                # unrelated clips mostly spreads hallucinations.
                condition_on_previous_text=False,
            )
            out = []
            for s in segments:
                text = s.text.strip()
                if not text:
                    continue
                if s.no_speech_prob > MAX_NO_SPEECH and s.avg_logprob < MIN_LOGPROB:
                    continue
                out.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text})
            emit({"id": job["id"], "segments": out, "language": info.language})
        except Exception as e:  # keep serving; report the failure for this clip
            log(f"job {job.get('id')} failed: {e}")
            emit({"id": job.get("id"), "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        # The bot went away; nothing left to answer.
        sys.exit(0)
