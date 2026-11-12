"""
Detector de BPM: copia en Python de src/audio/bpm.ts (la explicación está allí).

Los dos deben dar el mismo resultado: si cambias uno, cambia el otro.
"""

from __future__ import annotations

import numpy as np

MIN_BPM = 70
MAX_BPM = 180
FRAMES_PER_SECOND = 100  # trocitos de 10 ms


def detect_beats(audio: np.ndarray, sample_rate: int) -> tuple[float, float] | None:
    """`audio`: matriz [canales, muestras]. Devuelve (bpm, primer_golpe_en_segundos) o None."""
    env, kick = onset_envelope(audio, sample_rate)
    if len(env) < FRAMES_PER_SECOND * 10:
        return None
    coarse = coarse_bpm(env)
    if coarse is None:
        return None
    fine = refine_bpm(env, coarse)
    rounded = round(fine)
    bpm = float(rounded) if abs(fine - rounded) < 0.08 else round(fine, 2)
    # Dónde cae el golpe: SOLO con el bombo (las palmadas van medio golpe después).
    phase, _ = best_phase(kick, bpm, 0.25)
    return bpm, round(phase / FRAMES_PER_SECOND, 3)


def _one_pole_lowpass(x: np.ndarray, hz: float, sample_rate: int) -> np.ndarray:
    """Paso bajo de un polo: y[n] = y[n-1] + a·(x[n] - y[n-1])."""
    import torch
    import torchaudio.functional as F  # viene instalado con Demucs

    a = 1 - np.exp(-2 * np.pi * hz / sample_rate)
    return F.lfilter(
        torch.from_numpy(x),
        a_coeffs=torch.tensor([1.0, -(1 - a)], dtype=torch.float64),
        b_coeffs=torch.tensor([a, 0.0], dtype=torch.float64),
        clamp=False,
    ).numpy()


def onset_envelope(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    """Devuelve (todos los golpes, solo el bombo). Ver src/audio/bpm.ts."""
    hop = round(sample_rate / FRAMES_PER_SECOND)
    mono = audio.astype(np.float64).mean(axis=0)
    frames = len(mono) // hop

    low = _one_pole_lowpass(mono, 150, sample_rate)
    deep = _one_pole_lowpass(_one_pole_lowpass(mono, 120, sample_rate), 120, sample_rate)

    sl = slice(0, frames * hop)

    def energy(x: np.ndarray) -> np.ndarray:
        return np.log1p(1000 * (x[sl] ** 2).reshape(frames, hop).mean(axis=1))

    full, lowe, deepe = energy(mono), energy(low), energy(deep)

    onset = np.zeros(frames)
    onset[1:] = np.maximum(0, np.diff(full)) + np.maximum(0, np.diff(lowe))
    kick = np.zeros(frames)
    kick[1:] = np.maximum(0, np.diff(deepe))
    return _peaks_only(onset), _peaks_only(kick)


def _peaks_only(onset: np.ndarray) -> np.ndarray:
    """Restamos la media local (1 s) para que solo cuenten los picos."""
    frames = len(onset)
    window = FRAMES_PER_SECOND
    csum = np.cumsum(onset)
    sums = csum.copy()
    sums[window:] = csum[window:] - csum[:-window]
    counts = np.minimum(np.arange(1, frames + 1), window)
    return np.maximum(0, onset - sums / counts)


def coarse_bpm(env: np.ndarray) -> float | None:
    max_lag = int(np.ceil(FRAMES_PER_SECOND * 60 / MIN_BPM * 4)) + 2
    n = len(env)
    ac = np.zeros(max_lag + 2)
    for lag in range(1, max_lag + 1):
        ac[lag] = np.dot(env[: n - lag], env[lag:]) / (n - lag)

    def at(lag: float) -> float:
        i = int(np.floor(lag))
        t = lag - i
        return ac[i] * (1 - t) + ac[i + 1] * t

    best, best_score = None, 0.0
    bpm = float(MIN_BPM)
    while bpm <= MAX_BPM:
        period = FRAMES_PER_SECOND * 60 / bpm
        score = at(period) + at(2 * period) + 0.5 * at(3 * period) + 0.5 * at(4 * period)
        score *= np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)
        if score > best_score:
            best_score, best = score, bpm
        bpm += 0.1
    return best


def refine_bpm(env: np.ndarray, coarse: float) -> float:
    best, best_score = coarse, -1.0
    for bpm in np.arange(coarse - 1.5, coarse + 1.5 + 1e-9, 0.01):
        _, s = best_phase(env, float(bpm), 1.0)
        if s > best_score:
            best_score, best = s, float(bpm)
    return best


def best_phase(env: np.ndarray, bpm: float, step: float) -> tuple[float, float]:
    """Para un BPM, prueba todas las "fases" (dónde cae el primer golpe) a la vez
    y devuelve (mejor_fase_en_trocitos, puntuación)."""
    period = FRAMES_PER_SECOND * 60 / bpm
    idx = np.arange(len(env) - 1)
    phases = np.arange(0, period, step)
    beats = np.arange(0, (len(env) - 1) / period)
    pos = phases[:, None] + beats[None, :] * period
    pos = np.where(pos < len(env) - 1, pos, np.nan)
    i = np.floor(np.nan_to_num(pos, nan=0)).astype(int)
    t = np.nan_to_num(pos, nan=0) - i
    vals = env[idx[i]] * (1 - t) + env[idx[i] + 1] * t
    scores = np.where(np.isnan(pos), 0, vals).sum(axis=1)
    k = int(scores.argmax())
    return float(phases[k]), float(scores[k])
