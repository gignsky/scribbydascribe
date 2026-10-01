#!/usr/bin/env python3
"""faster-whisper worker for scribbydascribe.

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

# /scribe transpose (party mode): a voice embedding for clips whose speaker is
# a shared mic, so the bot can cluster them by voice. Loaded on first use
# only, so a server that never uses party mode never pays for it.
SPEAKER_MODEL = os.environ.get("WHISPER_SPEAKER_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
SPEAKER_MODEL_DIR = os.environ.get("WHISPER_SPEAKER_MODEL_DIR", os.path.join(os.environ.get("HF_HOME", "/data/models"), "spkrec-ecapa-voxceleb"))
_classifier = None

# Segments Whisper itself doubts are dropped: these are where it invents
# "Thank you." or subtitle credits out of breath noise.
MAX_NO_SPEECH = 0.6
MIN_LOGPROB = -1.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(*args):
    print("[worker]", *args, file=sys.stderr, flush=True)


def get_classifier():
    """Load the speaker-embedding model on first use (lazily: it is a sizeable
    download+load that most servers, not using party mode, never need)."""
    global _classifier
    if _classifier is None:
        log(f"loading speaker-embedding model {SPEAKER_MODEL}")
        from speechbrain.inference.speaker import EncoderClassifier

        _classifier = EncoderClassifier.from_hparams(source=SPEAKER_MODEL, savedir=SPEAKER_MODEL_DIR)
    return _classifier


def embed(path):
    """A voice embedding for one clip, as a plain list of floats."""
    classifier = get_classifier()
    signal = classifier.load_audio(path)
    vector = classifier.encode_batch(signal.unsqueeze(0)).squeeze()
    return [round(x, 5) for x in vector.tolist()]


def main():
    log(f"loading model {MODEL} ({DEVICE}/{COMPUTE})")
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS)
    emit({"ready": True, "model": MODEL, "device": DEVICE})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        if job.get("embedOnly"):
            # Retroactive /scribe transpose: just the voice embedding, no ASR.
            try:
                emit({"id": job["id"], "embedding": embed(job["path"])})
            except Exception as e:
                log(f"job {job.get('id')} speaker embedding failed: {e}")
                emit({"id": job.get("id"), "error": str(e)})
            continue
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
            result = {"id": job["id"], "segments": out, "language": info.language}
            if job.get("embed"):
                try:
                    result["embedding"] = embed(job["path"])
                except Exception as e:
                    # /scribe transpose falls back to the Discord account alone.
                    log(f"job {job.get('id')} speaker embedding failed: {e}")
            emit(result)
        except Exception as e:  # keep serving; report the failure for this clip
            log(f"job {job.get('id')} failed: {e}")
            emit({"id": job.get("id"), "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        # The bot went away; nothing left to answer.
        sys.exit(0)
