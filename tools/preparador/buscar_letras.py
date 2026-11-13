"""
Buscador de letras de dj-app (fase 1: solo internet)
=====================================================

Para cada canción YA SEPARADA por el preparador, busca su letra escrita de
verdad en LRCLIB (https://lrclib.net), una base de datos de letras gratuita y
abierta: no pide cuenta ni clave. Muchas letras vienen SINCRONIZADAS por
frases (cada frase con el segundo en que se canta, como en un karaoke).

Guarda lo que encuentra junto a los stems de cada canción:

    _stems/<huella>/letra-online.json

Este programa NO usa la tarjeta gráfica ni toca biblioteca.json, los stems
ni letra.json. Por eso se puede lanzar A LA VEZ que el preparador, en otra
ventana, sin que se estorben ni se ralenticen.

(Fase 2, más adelante: usar el stem de voces para colocar cada palabra de esta
letra correcta en su momento exacto, y que la app la muestre en la onda).

Cómo se usa (desde la carpeta dj-app):

    tools\\preparador\\.venv\\Scripts\\python tools\\preparador\\buscar_letras.py "C:\\ruta\\a\\tu\\musica"

Opciones:
    --reintentar   vuelve a buscar las que la otra vez NO se encontraron
    --limite N     buscar como mucho N canciones (para probar)

Se puede parar con Ctrl + C: al relanzarlo salta las que ya buscó. Las
canciones que el preparador separe después se buscan al volver a lanzarlo.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

STEMS_DIRNAME = "_stems"
LIBRARY_FILENAME = "biblioteca.json"
ONLINE_FILENAME = "letra-online.json"
FORMAT_VERSION = 1

API = "https://lrclib.net/api/search"
# LRCLIB pide que cada programa se identifique con un nombre propio.
HEADERS = {"User-Agent": "dj-app-preparador/1.0"}
# La letra solo vale si la duración coincide: así no cogemos la de la versión
# original cuando tu archivo es un remix (que suele durar distinto).
MAX_DURATION_DIFF = 4.0  # segundos
PAUSE = 0.25  # pequeña pausa entre búsquedas, para no saturar su servidor


# --- Nombre de la canción -------------------------------------------------------


def split_name(entry: dict) -> tuple[str, str]:
    """Saca (título, artista). Si el mp3 no trae etiquetas, el preparador
    guardó el nombre del archivo como título, p. ej. "Polaroid - Eladio Carrion"."""
    title = (entry.get("title") or "").strip()
    artist = (entry.get("artist") or "").strip()
    if not artist and " - " in title:
        left, right = title.rsplit(" - ", 1)
        # Lo normal en tus archivos es "Título - Artista".
        title, artist = left.strip(), right.strip()
    return title, artist


def clean(text: str) -> str:
    """Quita lo que confunde al buscador: "(Remix)", "[Official Video]", "feat. X"…"""
    text = re.sub(r"\(.*?\)|\[.*?\]", " ", text)
    text = re.sub(r"\b(feat|ft|featuring)\.?\s.*$", " ", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip(" -_")


def main_artist(artist: str) -> str:
    """"Eladio Carrion, Bad Bunny" o "X & Y" → solo el primero."""
    return re.split(r",|&| x | y |\bfeat\b|\bft\b", artist, maxsplit=1, flags=re.IGNORECASE)[0].strip()


def queries(title: str, artist: str) -> list[dict]:
    """Distintas formas de preguntar, de la más exacta a la más suelta."""
    tries = [
        {"track_name": title, "artist_name": artist},
        {"track_name": clean(title), "artist_name": main_artist(clean(artist))},
        {"q": f"{clean(title)} {main_artist(clean(artist))}"},
        {"q": f"{main_artist(clean(artist))} {clean(title)}"},  # por si el nombre era "Artista - Título"
    ]
    seen, out = set(), []
    for t in tries:
        key = tuple(sorted(t.items()))
        if all(v for v in t.values()) and key not in seen:
            seen.add(key)
            out.append(t)
    return out


# --- Búsqueda -------------------------------------------------------------------


def search(session: requests.Session, params: dict) -> list[dict]:
    """Una búsqueda en LRCLIB, con 3 intentos por si falla la conexión."""
    for attempt in range(3):
        try:
            r = session.get(API, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    return []


def best_match(results: list[dict], duration: float) -> dict | None:
    """De todos los resultados, el que dura lo mismo que tu archivo, prefiriendo
    los que traen letra sincronizada (con tiempos)."""
    good = [
        r for r in results
        if r.get("duration") and abs(r["duration"] - duration) <= MAX_DURATION_DIFF
        and not r.get("instrumental") and (r.get("syncedLyrics") or r.get("plainLyrics"))
    ]
    if not good:
        return None
    return min(good, key=lambda r: (not r.get("syncedLyrics"), abs(r["duration"] - duration)))


LRC_LINE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)")


def parse_lrc(lrc: str) -> list[dict]:
    """Formato LRC ("[01:23.45] frase") → [{"t": 83.45, "texto": "frase"}, ...]."""
    lines = []
    for raw in lrc.splitlines():
        m = LRC_LINE.match(raw.strip())
        if m:
            minutes, seconds, text = m.groups()
            lines.append({"t": round(int(minutes) * 60 + float(seconds), 2), "texto": text.strip()})
    return lines


def write_json_safe(path: Path, data) -> None:
    """Escribe a un temporal y lo cambia de golpe: nunca queda un archivo a medias."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


# --- Programa -------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Busca en internet la letra de las canciones ya separadas.")
    parser.add_argument("musica", type=Path, help="La misma carpeta de música que usa el preparador")
    parser.add_argument("--reintentar", action="store_true", help="Volver a buscar las que no se encontraron")
    parser.add_argument("--limite", type=int, default=0, help="Buscar como mucho N canciones (0 = todas)")
    args = parser.parse_args()

    stems_dir = args.musica.resolve() / STEMS_DIRNAME
    library_path = stems_dir / LIBRARY_FILENAME
    if not library_path.exists():
        print(f"No encuentro {library_path}. ¿Has separado ya alguna canción con el preparador?")
        return 1
    # Solo LEEMOS biblioteca.json, y una única vez: es el registro del preparador
    # (que puede estar trabajando a la vez) y no queremos estorbarle.
    tracks = json.loads(library_path.read_text(encoding="utf-8"))["tracks"]

    pending = []
    for entry in tracks.values():
        folder = stems_dir / entry["folder"]
        if not folder.is_dir():
            continue
        out = folder / ONLINE_FILENAME
        if out.exists():
            previous = json.loads(out.read_text(encoding="utf-8"))
            if previous.get("encontrada") or not args.reintentar:
                continue  # ya buscada
        pending.append(entry)
    print(f"Canciones separadas: {len(tracks)} · Por buscar: {len(pending)}")
    if args.limite:
        pending = pending[: args.limite]

    session = requests.Session()
    session.headers.update(HEADERS)
    found = synced = missing = errors = 0
    started = time.time()
    try:
        for i, entry in enumerate(pending, 1):
            title, artist = split_name(entry)
            duration = float(entry.get("duration") or 0)
            print(f"[{i}/{len(pending)}] {title} — {artist or '?'}", end=" … ", flush=True)
            try:
                match = None
                for params in queries(title, artist):
                    match = best_match(search(session, params), duration)
                    time.sleep(PAUSE)
                    if match:
                        break
            except (requests.RequestException, ValueError) as err:
                # Sin conexión o el servidor falla: NO guardamos nada, así se
                # vuelve a intentar al relanzar.
                errors += 1
                print(f"ERROR de conexión ({err.__class__.__name__}), se reintentará la próxima vez")
                continue

            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            out = stems_dir / entry["folder"] / ONLINE_FILENAME
            if not match:
                missing += 1
                write_json_safe(out, {"version": FORMAT_VERSION, "encontrada": False, "fecha": now})
                print("no encontrada")
                continue

            lines = parse_lrc(match.get("syncedLyrics") or "")
            write_json_safe(out, {
                "version": FORMAT_VERSION,
                "encontrada": True,
                "fuente": "lrclib",
                "id": match.get("id"),
                "titulo": match.get("trackName"),
                "artista": match.get("artistName"),
                "duracion": match.get("duration"),
                "sincronizada": lines or None,  # frases con su segundo (si las hay)
                "plana": match.get("plainLyrics") or "",  # la letra entera, sin tiempos
                "fecha": now,
            })
            found += 1
            if lines:
                synced += 1
                print(f"OK, sincronizada ({len(lines)} frases)")
            else:
                print("OK, solo texto (sin tiempos)")
    except KeyboardInterrupt:
        print("\nParado. Lo hecho está guardado; vuelve a lanzarlo para continuar.")

    took = (time.time() - started) / 60
    print(f"\nEncontradas: {found} (sincronizadas: {synced}) · No encontradas: {missing} · "
          f"Errores de conexión: {errors} · Tiempo: {took:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
