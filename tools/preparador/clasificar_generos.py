"""
Clasificador de GÉNEROS de dj-app
=================================

Reparte las canciones ya preparadas en géneros (Reggaetón, Trap, Español…)
para que la app las enseñe en PESTAÑAS encima de la lista de canciones.

No mueve ni toca ningún mp3: solo escribe un archivo con las listas,

    _stems/generos.json

y la app lo lee. Una canción puede estar en dos pestañas a la vez
(p. ej. una de Quevedo está en "Reggaetón" y en "Español").

Cómo decide el género (sin escuchar la canción):
  1. Por el ARTISTA: sabemos qué estilo hace y de dónde es (tabla de abajo).
  2. Para los artistas que hacen de todo (Bad Bunny, Anuel, Myke Towers…),
     por el BPM: entre ~84 y ~106 (o el doble) suele ser reggaetón; si no, trap.
No es perfecto (para eso habría que escuchar la canción), pero acierta en la
mayoría. Si una canción está mal, se corrige en CORRECCIONES (más abajo).

Cómo se usa (desde la carpeta dj-app):

    tools\\preparador\\.venv\\Scripts\\python tools\\preparador\\clasificar_generos.py "D:\\musica separada"

Se puede volver a lanzar cuando añadas canciones: rehace las listas enteras.
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

# --- Las pestañas, en el orden en que salen en la app ------------------------------
GENRES = [
    ("reggaeton", "Reggaetón"),
    ("trap", "Trap"),
    ("espanol", "Español"),
    ("rap", "Rap"),
    ("oldschool", "Old school"),
    ("dembow", "Dembow"),
    ("corridos", "Corridos"),
    ("latino", "Latino"),
    ("electronica", "Electrónica"),
    ("pop", "Pop"),
    ("clasicos", "Clásicos españoles"),
    ("fiestas", "Fiestas"),
]

# --- Qué hace cada artista -------------------------------------------------------
#   urbano    = hace reggaetón y trap: decide el BPM
#   reggaeton / trap / rap / dembow / corridos / latino / electronica / pop /
#   clasicos / fiestas = siempre ese estilo
#   oldschool = clásico del reggaetón (va a "Old school" y también a "Reggaetón")
#   espanol   = artista de España (además de su estilo, va a "Español")
ARTISTS: dict[str, set[str]] = {}


def add(tags: str, *names: str) -> None:
    for name in names:
        ARTISTS[norm(name)] = set(tags.split())


def norm(text: str) -> str:
    """Minúsculas y sin tildes, para comparar nombres sin líos."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", text.lower().replace("- topic", "")).strip()


# Urbano latino (reggaetón y trap, según la canción)
add("urbano", "Bad Bunny", "Anuel AA", "Duki", "Myke Towers", "Omar Courtz", "Eladio Carrion", "Mora",
    "Bryant Myers", "Clarent", "Arcangel", "Tainy", "Dei V", "JHAYCO", "Rauw Alejandro", "Ozuna", "Blessd",
    "Hades66", "De La Rose", "J Balvin", "ROA", "Nicky Jam", "Cris MJ", "Cosculluela", "Sech", "Chris Jedi",
    "Samuel G", "Jay Wheeler", "KHEA", "iZaak", "Maluma", "Oscar el Ruso", "Nengo Flow", "Nio Garcia", "Darell",
    "KAROL G", "Brytiago", "Justin Quiles", "Casper Magico", "Luar La L", "Lucho RK", "FloyyMenor", "Conep",
    "Yapi", "Revol", "Brray", "Sky Rompiendo", "Alex Rose", "Farruko", "Kidd Voodoo", "Jombriel", "Rvssian",
    "Lunay", "MYLO AA", "Camin", "Feid", "Rei", "Ele A El Dominio", "Amenazzy", "LIT killah", "Hanzel La H",
    "Lil Naay", "YOVNGCHIMI", "Super Yei", "Gaby Music", "Mattei", "Anthony", "Yampi", "Lary Over", "J Abdiel",
    "Ovy On The Drums", "Xiyo", "Slayter", "Mac", "Juseph", "KEVVO", "Rusherking", "Bandaga", "NATTI NATASHA",
    "El Daddy", "Anonimus", "Midel", "Youka", "Prok", "TWENTY SIX", "Alleh", "Castion", "Mike Duran", "Milly",
    "El Conejo", "Juos", "Icardy", "Los Ballers", "Sahir", "Kapo", "Frank Miami", "Joyce Santana", "Tempo",
    "LiL CaKe", "Little Homie", "ORO600", "Leebrian", "BANDIDO", "DIA", "Came Beats", "Young Cister", "Milo j",
    "Anubiis", "Yannc", "Liderj", "J Castle", "Modo Diablo", "Fuego", "Game Over", "BENNETT", "CJ", "Reina Mora",
    "Julianno Sosa", "Kris R.", "Tiago PZK", "Noriel", "Chefin", "Casagrande", "Alvaro Diaz", "KEVIN ROLDAN",
    "mvrk", "La 2ble A", "Midnvght", "Johan Urba", "ANMI", "Peereira7", "FANTA ROSARIO", "Jon Z", "Gonzy",
    "Seguí", "Pressure 9X19", "Ovi", "Benny Benni", "Alejo", "Kendo Kaponi", "Lyanno", "Chencho Corleone",
    "Jowell & Randy", "Mambo Kingz", "Alex Sensation", "Sixto Rein", "Young Miko", "Dj Nau", "Wolfine",
    "Trap Capos", "W Sound", "Panda Black", "Samueliyo Baby", "Biwan La Pauta", "Pedro Calderon", "Tivi Gunz",
    "Louis BPM", "Hydro", "Fito la R", "Piero 47", "Mr. Goat", "LA M RECORDS", "paopao", "Lucho SSJ")

# Urbano de ESPAÑA (además de su estilo, salen en "Español")
add("urbano espanol", "Quevedo", "JC Reyes", "SAIKO", "La Pantera", "Yan Block", "Lucho RK", "Omar Montes",
    "Bad Gyal", "Lia Kali", "Moncho Chavea", "Dasoul", "DaniMflow", "Chanell", "Aissa", "Maikel Delacalle",
    "Rels B", "Juan Magan", "Kiko Rivera", "Alba Moreno", "Israel B")
add("rap espanol", "Morad", "Delaossa", "Kidd Keo", "Cruz Cafune", "Hoke", "El Jincho", "Raul Clyde")

# Rap / hip-hop (EE. UU., Argentina, Chile, México…)
add("rap", "Travis Scott", "Juice WRLD", "50 Cent", "Future", "6ix9ine", "JAY-Z", "Cardi B", "Nicki Minaj",
    "JACKBOYS", "Trueno", "YSY A", "Residente", "Bizarrap", "Neo Pistea", "Pablo Chill-E", "Bhavi",
    "Polima Westcoast", "Santa Fe Klan", "Foreign Teck")

# Clásicos del reggaetón
add("oldschool", "Daddy Yankee", "Don Omar", "Tego Calderon", "Wisin", "Yandel", "Alexis y Fido", "Plan B",
    "J Alvarez", "Nejo", "DJ Nelson", "Yomo", "Jory Boy", "Gigolo Y La Exce", "Angeliyo El Blanco",
    "De La Ghetto", "Randy Nota Loca", "Producto Sin Corte", "Zion & Lennox", "Arcangel & De La Ghetto")

add("dembow", "El Alfa", "Tokischa", "Chucky73", "Yaisel LM", 'Osmani Garcia "La Voz"', "El Chulo", "Bulova")
add("corridos", "Natanael Cano", "Grupo Frontera", "Carin Leon", "Chanela Clicka", "Peso Pluma", "Junior H")
add("latino", "Aventura", "Marc Anthony", "Luck Ra", "Los G4", "Beele", "Danny Ocean", "Manuel Turizo",
    "Charly Black", "Skales", "Gusttavo Lima", "Nacho", "Cali Y El Dandee", "Los Sufridos", "Carly", "GIMS",
    "Romeo Santos", "Prince Royce")
add("electronica", "Avicii", "David Guetta", "Calvin Harris", "Marshmello", "Major Lazer", "HUGEL", "Alice Deejay",
    "LiveAct Encore", "DJ Borr-X", "Electro Convulsive", "New Beat Order", "Two Good", "Rich Music LTD",
    "Alex Gargolas", "MOONLIGHT S", "Century", "KARBeats", "DJ BREVNO", "MADE", "Mark B.", "Panaka",
    "David Sanchez y Narvi")
add("pop", "Coldplay", "Ed Sheeran", "Maroon 5", "Bruno Mars", "Justin Bieber", "Taylor Swift", "Sam Smith",
    "The Weeknd", "WALK THE MOON", "Panic! At The Disco", "George Ezra", "Justin Timberlake", "Black Eyed Peas",
    "Pitbull", "Jennifer Lopez", "Sebastian Yatra", "ROSALIA", "Emilia", "Becky G", "The Academy: Segunda Mision")
add("pop espanol", "Aitana", "Lola Indigo")
add("clasicos", "Fito y Fitipaldis", "Estopa", "Loquillo Y Los Trogloditas", "Rosendo", "Marea", "Manolo Escobar")
add("fiestas", "Cercle Musical Primitiva Albaidense el Gamell", "Colla De Tabals I Dolcaines Montolivet",
    "Daviles de Novelda", "David Valera Ruiz", "Amando Blanquer Ponsoda", "Juan Manuel Carmona Suarez",
    "Antonio Carrillos Colomina", "Alejandro Samper Baidez", "George Centeno")

# Correcciones a mano: parte del título (en minúsculas) → géneros. Mandan sobre todo lo demás.
CORRECCIONES: dict[str, set[str]] = {
    # p. ej.  "gasolina": {"oldschool"},
}

# Palabras del título que delatan el género (por si el artista no está en la tabla).
TITLE_HINTS = [
    (r"\b(pasodoble|marcha mora|marcha cristiana|moros|cristians|alferes|dimonis|zulues|templaris|esparters)\b", "fiestas"),
    (r"\b(extended|liveact|remember|makina|bootleg|original mix|club mix)\b", "electronica"),
    (r"\bcorrido", "corridos"),
    (r"\bbachata\b", "latino"),
]


def split_artists(text: str) -> list[str]:
    return [a.strip() for a in re.split(r",|/|&| x | feat\.? | ft\.? ", text or "") if a.strip()]


def is_reggaeton_bpm(bpm: float | None) -> bool:
    """El reggaetón suele ir a 84-106 BPM (a veces el programa lo detecta al doble)."""
    if not bpm:
        return True
    return 84 <= bpm <= 106 or 168 <= bpm <= 212


def classify(entry: dict) -> tuple[set[str], bool]:
    """Devuelve (géneros, ¿conocíamos al artista?)."""
    title = (entry.get("title") or "").lower()
    for key, tags in CORRECCIONES.items():
        if key in title:
            return set(tags), True

    artists = split_artists(entry.get("artist") or "")
    known = [ARTISTS[norm(a)] for a in artists if norm(a) in ARTISTS]
    main = ARTISTS.get(norm(artists[0])) if artists else None
    genres: set[str] = set()

    # Estilo: el del artista principal; si no lo conocemos, el del primero que conozcamos.
    style_tags = main or (known[0] if known else None)
    if style_tags is None:
        for pattern, genre in TITLE_HINTS:
            if re.search(pattern, title):
                return {genre}, False
        style_tags = {"urbano"}  # casi toda tu música es urbana: es lo más probable

    for tag in style_tags - {"espanol"}:
        if tag == "urbano":
            genres.add("reggaeton" if is_reggaeton_bpm(entry.get("bpm")) else "trap")
        elif tag == "oldschool":
            genres.update({"oldschool", "reggaeton"})
        else:
            genres.add(tag)

    # Corridos o dembow en cualquier colaborador → también a esa pestaña.
    for tags in known:
        genres.update(tags & {"corridos", "dembow"})
    # Algún artista de España → también a "Español" (salvo clásicos/fiestas, que ya tienen la suya).
    if any("espanol" in tags for tags in known) and not genres & {"clasicos", "fiestas"}:
        genres.add("espanol")
    return genres, bool(known)


def main() -> int:
    if len(sys.argv) < 2:
        print('Uso: clasificar_generos.py "CARPETA DE MÚSICA"')
        return 1
    stems_dir = Path(sys.argv[1]).resolve() / "_stems"
    library = json.loads((stems_dir / "biblioteca.json").read_text(encoding="utf-8"))["tracks"]

    lists: dict[str, list[str]] = {gid: [] for gid, _ in GENRES}
    unknown: list[dict] = []
    for song_id, entry in library.items():
        genres, known = classify(entry)
        if not known:
            unknown.append(entry)
        for gid in genres:
            lists[gid].append(song_id)

    data = {
        "version": 1,
        "generos": [{"id": gid, "nombre": name, "canciones": lists[gid]} for gid, name in GENRES if lists[gid]],
    }
    out = stems_dir / "generos.json"
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, out)

    print(f"Canciones: {len(library)}  ·  guardado en {out}\n")
    for gid, name in GENRES:
        print(f"  {name:<20} {len(lists[gid]):>5}")
    if unknown:
        print(f"\nArtistas que no conozco ({len(unknown)} canciones; las he puesto por BPM o por el título):")
        for name, n in Counter(split_artists(e.get("artist") or "")[0] for e in unknown).most_common():
            print(f"  · {name} ({n})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
