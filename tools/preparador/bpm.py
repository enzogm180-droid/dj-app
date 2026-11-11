"""
Detector de BPM: copia en Python de src/audio/bpm.ts (la explicación está allí).

Los dos deben dar el mismo resultado: si cambias uno, cambia el otro.
"""

from __future__ import annotations

import numpy as np

MIN_BPM = 70
MAX_BPM = 180
FRAMES_PER_SECOND = 100  # trocitos de 10 ms


def detect_bpm(audio: np.ndarray, sample_rate: int) -> float | None:
    """`audio`: matriz [canales, muestras]. Devuelve el BPM o None."""
    env = onset_envelope(audio, sample_rate)
    if len(env) < FRAMES_PER_SECOND * 10:
        return None
    coarse = coarse_bpm(env)
    if coarse is None:
        return None
    fine = refine_bpm(env, coarse)
    rounded = round(fine)
    return float(rounded) if abs(fine - rounded) < 0.08 else round(fine, 2)


def onset_envelope(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    hop = round(sample_rate / FRAMES_PER_SECOND)
    mono = audio.astype(np.float64).mean(axis=0)
    frames = len(mono) // hop

    # Paso bajo de un polo (~150 Hz): y[n] = y[n-1] + a·(x[n] - y[n-1])
    alpha = 1 - np.exp(-2 * np.pi * 150 / sample_rate)
    import torch
    import torchaudio.functional as F  # viene instalado con Demucs

    low = F.lfilter(
        torch.from_numpy(mono),
        a_coeffs=torch.tensor([1.0, -(1 - alpha)], dtype=torch.float64),
        b_coeffs=torch.tensor([alpha, 0.0], dtype=torch.float64),
        clamp=False,
    ).numpy()

    sl = slice(0, frames * hop)
    e_full = (mono[sl] ** 2).reshape(frames, hop).mean(axis=1)
    e_low = (low[sl] ** 2).reshape(frames, hop).mean(axis=1)
    full = np.log1p(1000 * e_full)
    lowe = np.log1p(1000 * e_low)

    onset = np.zeros(frames)
    onset[1:] = np.maximum(0, np.diff(full)) + np.maximum(0, np.diff(lowe))

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
    idx = np.arange(len(env) - 1)
    for bpm in np.arange(coarse - 1.5, coarse + 1.5 + 1e-9, 0.01):
        period = FRAMES_PER_SECOND * 60 / bpm
        # Todas las fases a la vez: posiciones de cada golpe para cada fase.
        phases = np.arange(0, period, 1.0)
        beats = np.arange(0, (len(env) - 1) / period)
        pos = phases[:, None] + beats[None, :] * period
        pos = np.where(pos < len(env) - 1, pos, np.nan)
        i = np.floor(np.nan_to_num(pos, nan=0)).astype(int)
        t = np.nan_to_num(pos, nan=0) - i
        vals = env[idx[i]] * (1 - t) + env[idx[i] + 1] * t
        scores = np.where(np.isnan(pos), 0, vals).sum(axis=1)
        s = scores.max()
        if s > best_score:
            best_score, best = s, float(bpm)
    return best
