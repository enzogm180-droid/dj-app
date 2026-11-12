/**
 * Biblioteca: tu carpeta de música (en el PC o en un pincho USB).
 *
 * La app pide permiso para LEER esa carpeta (nunca escribe en ella), busca
 * todas las canciones y mira el registro que deja el preparador en
 * "_stems/biblioteca.json" para saber cuáles ya están separadas.
 *
 * La carpeta elegida se recuerda (en el almacenamiento interno del navegador),
 * así no tienes que buscarla cada vez: solo confirmar el permiso con un clic.
 */
import type { LyricWord, StemName } from '../audio/deck';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.aiff', '.aif', '.ogg', '.opus'];
const STEMS_DIRNAME = '_stems';
const LIBRARY_FILENAME = 'biblioteca.json';

/** Lo que el preparador guarda de cada canción (ver tools/preparador/preparar.py). */
interface PreparedEntry {
  file: string;
  title: string;
  artist: string;
  duration: number;
  bpm?: number | null;
  /** Segundo del primer golpe (rejilla de golpes). */
  beat?: number | null;
  folder: string;
  stems: Record<StemName, string>;
  /** Archivo con la letra palabra a palabra (si se sacó). */
  lyrics?: string;
}

export interface Track {
  /** Ruta dentro de la carpeta, p. ej. "House/tema.mp3". */
  path: string;
  title: string;
  artist: string;
  /** Duración en segundos (solo la sabemos si está preparada). */
  duration: number | null;
  /** BPM: lo calcula el preparador, o la app al cargar la canción por primera vez. */
  bpm: number | null;
  /** Segundo del primer golpe (si lo sabemos). */
  beat: number | null;
  /** Si está separada: dónde están sus stems. */
  stems: PreparedEntry | null;
}

export class Library {
  readonly root: FileSystemDirectoryHandle;
  readonly tracks: Track[];

  private constructor(root: FileSystemDirectoryHandle, tracks: Track[]) {
    this.root = root;
    this.tracks = tracks;
  }

  get name(): string {
    return this.root.name;
  }

  /** Recorre la carpeta y monta la lista de canciones. */
  static async open(root: FileSystemDirectoryHandle): Promise<Library> {
    const prepared = await readPrepared(root);
    const byPath = new Map(Object.values(prepared).map((e) => [e.file, e]));

    const tracks: Track[] = [];
    for await (const path of listAudio(root, '')) {
      const entry = byPath.get(path) ?? null;
      const name = path.split('/').pop()!.replace(/\.[^.]+$/, '');
      tracks.push({
        path,
        title: entry?.title || name,
        artist: entry?.artist ?? '',
        duration: entry?.duration ?? null,
        bpm: entry?.bpm ?? null,
        beat: entry?.beat ?? null,
        stems: entry,
      });
    }
    tracks.sort((a, b) => a.title.localeCompare(b.title, 'es'));
    return new Library(root, tracks);
  }

  /** Lee el archivo original de una canción. */
  async readTrack(track: Track): Promise<ArrayBuffer> {
    return (await getFile(this.root, track.path)).arrayBuffer();
  }

  /** Lee los 4 stems de una canción preparada. */
  async readStems(track: Track): Promise<Record<StemName, ArrayBuffer>> {
    const entry = track.stems!;
    const names = Object.keys(entry.stems) as StemName[];
    const buffers = await Promise.all(
      names.map(async (name) =>
        (await getFile(this.root, `${STEMS_DIRNAME}/${entry.folder}/${entry.stems[name]}`)).arrayBuffer(),
      ),
    );
    return Object.fromEntries(names.map((n, i) => [n, buffers[i]])) as Record<StemName, ArrayBuffer>;
  }

  /** Lee la letra de una canción preparada (o null si no tiene). */
  async readLyrics(track: Track): Promise<LyricWord[] | null> {
    const entry = track.stems;
    if (!entry?.lyrics) return null;
    try {
      const file = await getFile(this.root, `${STEMS_DIRNAME}/${entry.folder}/${entry.lyrics}`);
      return JSON.parse(await file.text());
    } catch {
      return null; // si falta o está mal, seguimos sin letra
    }
  }

  /**
   * Busca los stems de un archivo cargado "a mano" (con el botón Cargar),
   * reconociéndolo por su huella, igual que hace el preparador.
   */
  async findByContent(data: ArrayBuffer): Promise<Track | null> {
    const id = await fingerprint(data);
    return this.tracks.find((t) => t.stems?.folder === id) ?? null;
  }
}

// --- Elegir y recordar la carpeta ----------------------------------------------

/** Abre el selector de carpetas de Windows. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ id: 'musica', mode: 'read' });
  await saveHandle(handle);
  return handle;
}

/** La carpeta usada la última vez (si hay), y si ya tenemos permiso. */
export async function lastFolder(): Promise<{ handle: FileSystemDirectoryHandle; granted: boolean } | null> {
  const handle = await loadHandle();
  if (!handle) return null;
  const granted = (await handle.queryPermission({ mode: 'read' })) === 'granted';
  return { handle, granted };
}

/** Pide permiso para la carpeta recordada (necesita un clic del usuario). */
export async function reconnect(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

export function supportsFolders(): boolean {
  return 'showDirectoryPicker' in window;
}

// --- Ayudantes -----------------------------------------------------------------

async function readPrepared(root: FileSystemDirectoryHandle): Promise<Record<string, PreparedEntry>> {
  try {
    const file = await getFile(root, `${STEMS_DIRNAME}/${LIBRARY_FILENAME}`);
    return JSON.parse(await file.text()).tracks ?? {};
  } catch {
    return {}; // carpeta sin preparar todavía: no pasa nada
  }
}

/** Lista recursivamente todos los archivos de audio (menos los de _stems). */
async function* listAudio(dir: FileSystemDirectoryHandle, prefix: string): AsyncGenerator<string> {
  for await (const handle of dir.values()) {
    const path = prefix + handle.name;
    if (handle.kind === 'directory') {
      if (handle.name === STEMS_DIRNAME || handle.name.startsWith('.')) continue;
      yield* listAudio(handle as FileSystemDirectoryHandle, `${path}/`);
    } else if (AUDIO_EXTENSIONS.some((ext) => handle.name.toLowerCase().endsWith(ext))) {
      yield path;
    }
  }
}

async function getFile(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

/** Misma huella que el preparador: SHA-1 del archivo, primeros 16 caracteres. */
async function fingerprint(data: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// IndexedDB: el "cajón" del navegador donde recordamos la carpeta elegida.
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dj-app', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('ajustes');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const d = await db();
    d.transaction('ajustes', 'readwrite').objectStore('ajustes').put(handle, 'carpeta');
  } catch {
    // Si el navegador no deja guardarlo, simplemente habrá que elegirla otra vez.
  }
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction('ajustes').objectStore('ajustes').get('carpeta');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
