"""
Letra: convierte el stem de VOCES en texto, palabra a palabra, con el
momento exacto en que se canta cada una.

Usa Whisper (en su versión rápida, "faster-whisper"), una IA de
reconocimiento de voz. Como le damos solo la voz, sin música, entiende mucho
mejor que con la canción completa. Aun así no es perfecta: en canciones
rápidas o con mucho efecto en la voz puede equivocarse en alguna palabra.

Resultado (letra.json, junto a los stems de cada canción):
    [{"t": 12.34, "e": 12.80, "w": "hola"}, ...]
     t = cuándo empieza la palabra (s), e = cuándo acaba, w = la palabra
"""

from __future__ import annotations

import numpy as np
import torch
import torchaudio.functional as F

WHISPER_RATE = 16000  # Whisper trabaja con audio a 16 kHz


def load_model(name: str):
    """Carga el modelo. La primera vez lo descarga (small ≈ 500 MB)."""
    from faster_whisper import WhisperModel

    if torch.cuda.is_available():
        return WhisperModel(name, device="cuda", compute_type="float16")
    # En procesador, "int8" es mucho más rápido y casi igual de preciso.
    return WhisperModel(name, device="cpu", compute_type="int8")


def transcribe(model, vocals: np.ndarray, sample_rate: int, language: str | None = None) -> list[dict]:
    """`vocals`: matriz [canales, muestras]. Devuelve la lista de palabras."""
    mono = torch.from_numpy(np.ascontiguousarray(vocals, dtype=np.float32)).mean(dim=0)
    audio = F.resample(mono, sample_rate, WHISPER_RATE).numpy()

    segments, _info = model.transcribe(
        audio,
        language=language,  # None = que adivine el idioma él solo
        word_timestamps=True,  # queremos el momento de cada palabra
        vad_filter=True,  # se salta los trozos sin voz (evita "inventar" letra)
        condition_on_previous_text=False,  # evita que repita frases en bucle
        beam_size=5,
    )

    words = []
    for segment in segments:
        # Regla estándar de Whisper: descartamos un trozo solo si duda de que
        # haya voz Y ADEMÁS duda del texto. (Con solo la primera condición se
        # perdían estribillos enteros con la voz llena de efectos).
        if segment.no_speech_prob > 0.6 and segment.avg_logprob < -1.0:
            continue
        for w in segment.words or []:
            text = w.word.strip()
            if text and w.probability >= 0.2:
                words.append({"t": round(w.start, 2), "e": round(w.end, 2), "w": text})
    return words
