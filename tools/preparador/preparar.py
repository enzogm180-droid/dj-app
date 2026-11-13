"""
Preparador de stems de dj-app
=============================

Recorre una carpeta de música y, para cada canción:
  1. la separa en 4 partes (stems) con la IA Demucs,
  2. calcula su BPM (con el stem de batería),
  3. saca la letra palabra a palabra (con la IA Whisper, sobre el stem de voces),
y lo guarda todo junto a la música, en una subcarpeta "_stems":

    MI-MUSICA/
    ├── canción 1.mp3
    ├── canción 2.mp3
    └── _stems/
        ├── biblioteca.json        <- el registro: qué canción tiene qué stems
        ├── 3f9a1c.../             <- una carpeta por canción
        │   ├── vocals.opus        (voces)
        │   ├── drums.opus         (batería)
        │   ├── bass.opus          (bajo)
        │   ├── other.opus         (melodía / resto de instrumentos)
        │   └── letra.json         (la letra, con el momento de cada palabra)
        └── ...

Cómo se usa (desde la carpeta dj-app):

    tools\\preparador\\.venv\\Scripts\\python tools\\preparador\\preparar.py "C:\\ruta\\a\\tu\\musica"

Se puede parar con Ctrl + C cuando quieras: al volver a lanzarlo, salta las
canciones que ya estén hechas y sigue por donde iba.

Cada canción se identifica por su CONTENIDO (una "huella" del archivo), no por
su nombre: si renombras o mueves una canción, no hace falta separarla otra vez.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

from bpm import detect_beats
from letra import load_model as load_whisper
from letra import transcribe

SAMPLE_RATE = 44100  # frecuencia con la que trabaja Demucs
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".aiff", ".aif", ".ogg", ".opus"}
STEMS_DIRNAME = "_stems"
LIBRARY_FILENAME = "biblioteca.json"
LIBRARY_VERSION = 1
LYRICS_FILENAME = "letra.json"
# Versión del cálculo de la rejilla de golpes. Si la mejoramos, subimos el
# número y el preparador recalcula la rejilla de las canciones ya hechas.
GRID_VERSION = 2


# --- Utilidades ------------------------------------------------------------------


def fingerprint(path: Path) -> str:
    """Huella del archivo: cambia si cambia el audio, no si cambia el nombre."""
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def read_tags(path: Path) -> dict[str, str]:
    """Lee título y artista guardados dentro del archivo (si los tiene)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            capture_output=True, check=True, text=True, encoding="utf-8",
        ).stdout
        tags = {k.lower(): v for k, v in json.loads(out).get("format", {}).get("tags", {}).items()}
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        tags = {}
    return {
        "title": tags.get("title") or path.stem,
        "artist": tags.get("artist", ""),
    }


def decode(path: Path) -> torch.Tensor:
    """Convierte cualquier archivo de audio en números: [2 canales, muestras]."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True, check=True,
    ).stdout
    samples = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()
    return torch.from_numpy(samples)


def encode(audio: torch.Tensor, dest: Path, bitrate: str) -> None:
    """Guarda un stem comprimido en formato Opus (pequeño y de buena calidad)."""
    pcm = audio.clamp(-1, 1).T.contiguous().numpy().astype(np.float32).tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "-",
         "-c:a", "libopus", "-b:a", bitrate, str(dest)],
        input=pcm, check=True,
    )


def load_library(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"version": LIBRARY_VERSION, "tracks": {}}


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def save_library(library: dict, path: Path) -> None:
    """Guarda el registro de forma segura: primero a un archivo temporal y
    luego lo cambia de golpe. Así, si se va la luz, nunca queda a medias."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(library, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def is_hidden(p: Path, music_dir: Path) -> bool:
    """¿Es un archivo/carpeta oculto que NO es música de verdad?

    - "._canción.mp3": "sombra" que crea un Mac al copiar a un USB o disco.
      Pesa unos KB, solo guarda datos del Mac (carátula, etiquetas) y no es audio.
    - Cualquier cosa que empiece por "." (".Trashes", ".Spotlight-V100"…):
      carpetas internas del sistema. La app hace lo mismo al leer la carpeta.
    """
    return any(part.startswith(".") for part in p.relative_to(music_dir).parts)


def find_songs(music_dir: Path, stems_dir: Path) -> list[Path]:
    songs = [
        p for p in music_dir.rglob("*")
        if p.is_file()
        and p.suffix.lower() in AUDIO_EXTENSIONS
        and stems_dir not in p.parents
        and not is_hidden(p, music_dir)  # salta las "sombras" ._ del Mac
    ]
    return sorted(songs, key=lambda p: str(p).lower())


def is_done(entry: dict | None, stems_dir: Path) -> bool:
    if not entry:
        return False
    folder = stems_dir / entry["folder"]
    return all((folder / name).exists() for name in entry["stems"].values())


# --- Separación ------------------------------------------------------------------


def separate(model, wav: torch.Tensor, device: str, shifts: int) -> dict[str, torch.Tensor]:
    """Separa una canción. Devuelve {"vocals": audio, "drums": audio, ...}."""
    # Normalizamos el volumen como hace Demucs internamente y luego lo deshacemos.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (wav - mean) / std
    with torch.no_grad():
        out = apply_model(model, x[None], device=device, shifts=shifts, split=True, overlap=0.25, progress=False)[0]
    out = out * std + mean
    return {name: out[i] for i, name in enumerate(model.sources)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Separa toda una carpeta de música en stems.")
    parser.add_argument("musica", type=Path, help="Carpeta con tu música (puede ser un pincho USB)")
    parser.add_argument("--modelo", default="htdemucs",
                        help="htdemucs (por defecto, buen equilibrio) o htdemucs_ft (mejor calidad, ~4 veces más lento)")
    parser.add_argument("--calidad", default="96k", help="Bitrate de cada stem en Opus (por defecto 96k)")
    parser.add_argument("--pasadas", type=int, default=1,
                        help="Más pasadas = un poco más de calidad, pero más lento (por defecto 1)")
    parser.add_argument("--limite", type=int, default=0, help="Procesar como mucho N canciones (0 = todas)")
    parser.add_argument("--sin-letra", action="store_true", help="No sacar la letra de las canciones")
    parser.add_argument("--modelo-letra", default="small",
                        help="Modelo de Whisper para la letra: base (rápido), small (por defecto), "
                             "medium o large-v3 (mejor, para la torre con tarjeta gráfica)")
    parser.add_argument("--idioma", default=None,
                        help="Idioma de las letras, p. ej. 'es'. Si no lo pones, lo adivina en cada canción")
    parser.add_argument("--rehacer-letra", action="store_true",
                        help="Vuelve a sacar la letra de TODAS las canciones (p. ej. con un modelo mejor)")
    args = parser.parse_args()

    # El modelo de la letra se carga solo si hace falta, y una única vez.
    whisper = None

    def lyrics_of(vocals: np.ndarray) -> list[dict]:
        nonlocal whisper
        if whisper is None:
            print(f"\nCargando el modelo de letra '{args.modelo_letra}' (la primera vez se descarga)…", flush=True)
            whisper = load_whisper(args.modelo_letra)
        return transcribe(whisper, vocals, SAMPLE_RATE, args.idioma)

    music_dir: Path = args.musica.resolve()
    if not music_dir.is_dir():
        print(f"No encuentro la carpeta: {music_dir}")
        return 1
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"Falta '{tool}'. Instálalo con: winget install -e --id Gyan.FFmpeg")
            return 1

    stems_dir = music_dir / STEMS_DIRNAME
    stems_dir.mkdir(exist_ok=True)
    library_path = stems_dir / LIBRARY_FILENAME
    library = load_library(library_path)

    songs = find_songs(music_dir, stems_dir)
    print(f"Encontradas {len(songs)} canciones en {music_dir}")

    # ¿Qué canciones faltan? (calculamos la huella de cada una)
    pending: list[tuple[Path, str]] = []
    moved = 0
    for song in songs:
        song_id = fingerprint(song)
        entry = library["tracks"].get(song_id)
        if is_done(entry, stems_dir):
            # Ya está separada. Si la has renombrado o movido, apuntamos la ruta nueva.
            rel = song.relative_to(music_dir).as_posix()
            if entry["file"] != rel:
                entry["file"] = rel
                moved += 1
            continue
        pending.append((song, song_id))
    if moved:
        save_library(library, library_path)
        print(f"Actualizada la ruta de {moved} canciones renombradas o movidas")

    # Canciones separadas con una versión anterior del preparador, sin BPM o sin
    # rejilla de golpes ("beat" = segundo del primer golpe): lo calculamos ahora.
    missing_bpm = [
        e for e in library["tracks"].values() if e.get("grid") != GRID_VERSION and is_done(e, stems_dir)
    ]
    if missing_bpm:
        print(f"Calculando BPM y golpes de {len(missing_bpm)} canciones ya separadas…")
        for entry in missing_bpm:
            drums = decode(stems_dir / entry["folder"] / entry["stems"]["drums"])
            grid = detect_beats(drums.numpy(), SAMPLE_RATE)
            entry["bpm"], entry["beat"] = grid if grid else (None, None)
            entry["grid"] = GRID_VERSION
            print(f"  {entry['title']}: {entry['bpm']} BPM, primer golpe en {entry['beat']} s")
        save_library(library, library_path)

    # Lo mismo con la letra.
    missing_lyrics = [] if args.sin_letra else [
        e for e in library["tracks"].values()
        if (args.rehacer_letra or "lyrics" not in e) and is_done(e, stems_dir)
    ]
    if missing_lyrics:
        print(f"Sacando la letra de {len(missing_lyrics)} canciones ya separadas…")
        try:
            for entry in missing_lyrics:
                t0 = time.time()
                folder = stems_dir / entry["folder"]
                words = lyrics_of(decode(folder / entry["stems"]["vocals"]).numpy())
                write_json(folder / LYRICS_FILENAME, words)
                entry["lyrics"] = LYRICS_FILENAME
                save_library(library, library_path)
                print(f"  {entry['title']}: {len(words)} palabras en {time.time() - t0:.0f} s")
        except KeyboardInterrupt:
            print("\nParado. Lo hecho está guardado; vuelve a lanzarlo para continuar.")
            return 0
    print(f"Ya preparadas: {len(songs) - len(pending)} · Pendientes: {len(pending)}")
    if not pending:
        return 0
    if args.limite:
        pending = pending[: args.limite]
    if not pending:
        return 0

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Cargando modelo '{args.modelo}' en {'tarjeta gráfica' if device == 'cuda' else 'procesador'}…")
    model = get_model(args.modelo)
    model.eval()

    started = time.time()
    done = failed = 0
    try:
        for i, (song, song_id) in enumerate(pending, 1):
            rel = song.relative_to(music_dir).as_posix()
            print(f"[{i}/{len(pending)}] {rel}", end=" … ", flush=True)
            t0 = time.time()
            try:
                wav = decode(song)
                duration = wav.shape[1] / SAMPLE_RATE
                stems = separate(model, wav, device, args.pasadas)
                # El BPM se calcula con la batería: sin voces ni melodía es más fiable.
                grid = detect_beats(stems["drums"].numpy(), SAMPLE_RATE)
                bpm, first_beat = grid if grid else (None, None)

                # Escribimos en una carpeta temporal y la renombramos al final:
                # una canción solo aparece como "hecha" si está completa.
                final_dir = stems_dir / song_id
                tmp_dir = stems_dir / f"{song_id}.tmp"
                shutil.rmtree(tmp_dir, ignore_errors=True)
                tmp_dir.mkdir()
                files = {}
                for name, audio in stems.items():
                    filename = f"{name}.opus"
                    encode(audio, tmp_dir / filename, args.calidad)
                    files[name] = filename
                # La letra sale del stem de voces (sin música, Whisper entiende mucho mejor).
                words = None
                if not args.sin_letra:
                    words = lyrics_of(stems["vocals"].numpy())
                    write_json(tmp_dir / LYRICS_FILENAME, words)
                shutil.rmtree(final_dir, ignore_errors=True)
                tmp_dir.rename(final_dir)

                library["tracks"][song_id] = {
                    "file": rel,
                    **read_tags(song),
                    "duration": round(duration, 2),
                    "bpm": bpm,
                    "beat": first_beat,
                    "grid": GRID_VERSION,
                    "folder": song_id,
                    "stems": files,
                    **({"lyrics": LYRICS_FILENAME} if words is not None else {}),
                    "model": args.modelo,
                    "prepared": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                library["model"] = args.modelo
                save_library(library, library_path)

                took = time.time() - t0
                done += 1
                size_mb = sum(f.stat().st_size for f in final_dir.iterdir()) / 1e6
                lyrics_info = f", {len(words)} palabras de letra" if words is not None else ""
                print(f"OK en {took:.0f} s ({duration / took:.1f}× tiempo real, {size_mb:.1f} MB, {bpm} BPM{lyrics_info})")
            except subprocess.CalledProcessError as err:
                failed += 1
                print(f"ERROR leyendo/guardando audio: {(err.stderr or b'').decode(errors='ignore').strip()[:200]}")
            except Exception as err:  # noqa: BLE001 - seguimos con la siguiente canción
                failed += 1
                print(f"ERROR: {err}")
    except KeyboardInterrupt:
        print("\nParado. Lo hecho está guardado; vuelve a lanzarlo para continuar.")

    total = time.time() - started
    print(f"\nHechas: {done} · Con error: {failed} · Tiempo: {total / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
