/**
 * Biblioteca: tu carpeta de música (en el PC o en un pincho USB).
 *
 * La app busca todas las canciones y mira el registro que deja el preparador
 * en "_stems/biblioteca.json" para saber cuáles ya están separadas.
 *
 * Lo que TÚ creas mientras pinchas (hot cues; más adelante, playlists) se
 * guarda en "_stems/mis-datos.json", DENTRO de la carpeta. Así viaja con el
 * pincho a cualquier portátil, y con su copia. Por eso la app pide permiso
 * para EDITAR la carpeta. Solo escribe ese archivo: nunca toca tu música ni
 * lo que genera el preparador.
 *
 * La carpeta elegida se recuerda (en el almacenamiento interno del navegador),
 * así no tienes que buscarla cada vez: solo confirmar el permiso con un clic.
 */
import type { LyricWord, StemName } from '../audio/deck';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.aiff', '.aif', '.ogg', '.opus'];
const STEMS_DIRNAME = '_stems';
const LIBRARY_FILENAME = 'biblioteca.json';
const USER_DATA_FILENAME = 'mis-datos.json';

/** Lo que guardamos en "_stems/mis-datos.json". */
interface UserData {
  version: 1;
  /** Hot cues de cada canción (por su identificador), en segundos. */
  hotCues: Record<string, (number | null)[]>;
}

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
  /** ¿Tenemos permiso para guardar en la carpeta? (si no, se guarda en el navegador) */
  writable: boolean;
  private readonly data: UserData;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Se llama si falla un guardado (para avisarte en pantalla). */
  onSaveError: ((err: unknown) => void) | null = null;

  private constructor(root: FileSystemDirectoryHandle, tracks: Track[], data: UserData, writable: boolean) {
    this.root = root;
    this.tracks = tracks;
    this.data = data;
    this.writable = writable;
  }

  get name(): string {
    return this.root.name;
  }

  // --- Tus datos (mis-datos.json) ----------------------------------------------

  /** Hot cues guardados de una canción, o null si no hay. */
  getHotCues(id: string): (number | null)[] | null {
    return this.data.hotCues[id] ?? null;
  }

  /** Guarda los hot cues de una canción (se escriben en la carpeta enseguida). */
  setHotCues(id: string, cues: (number | null)[]): void {
    if (cues.every((c) => c === null)) delete this.data.hotCues[id];
    else this.data.hotCues[id] = [...cues];
    this.scheduleSave();
  }

  /**
   * Escribimos el archivo un instante después del último cambio: si cambias
   * varias cosas seguidas, se escribe una sola vez.
   */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 300);
  }

  private async save(): Promise<void> {
    this.saveTimer = null;
    try {
      const dir = await this.root.getDirectoryHandle(STEMS_DIRNAME, { create: true });
      const file = await dir.getFileHandle(USER_DATA_FILENAME, { create: true });
      // El navegador escribe en un archivo aparte y lo cambia de golpe al
      // cerrar: si se desconecta el pincho a medias, el archivo viejo sigue bien.
      const writer = await file.createWritable();
      await writer.write(JSON.stringify(this.data, null, 1));
      await writer.close();
    } catch (err) {
      console.error('No se pudo guardar en la carpeta', err);
      this.onSaveError?.(err);
    }
  }

  /** Recorre la carpeta y monta la lista de canciones. */
  static async open(root: FileSystemDirectoryHandle): Promise<Library> {
    const prepared = await readPrepared(root);
    const data = await readUserData(root);
    const writable = (await root.queryPermission({ mode: 'readwrite' })) === 'granted';
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
    return new Library(root, tracks, data, writable);
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

/**
 * Abre el selector de carpetas de Windows, pidiendo permiso para EDITAR (para
 * guardar tus hot cues en ella). Si no lo das, la abrimos solo para leer.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ id: 'musica', mode: 'readwrite' });
  } catch (err) {
    if ((err as DOMException).name !== 'NotAllowedError') throw err; // p. ej. cancelaste: no insistimos
    handle = await window.showDirectoryPicker({ id: 'musica', mode: 'read' });
  }
  await saveHandle(handle);
  return handle;
}

/** La carpeta usada la última vez (si hay), y si ya tenemos permiso. */
export async function lastFolder(): Promise<{ handle: FileSystemDirectoryHandle; granted: boolean } | null> {
  const handle = await loadHandle();
  if (!handle) return null;
  const granted = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  return { handle, granted };
}

/**
 * Pide permiso para la carpeta recordada (necesita un clic del usuario).
 * Primero para editarla; si no, al menos para leerla.
 */
export async function reconnect(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if ((await handle.requestPermission({ mode: 'readwrite' })) === 'granted') return true;
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

async function readUserData(root: FileSystemDirectoryHandle): Promise<UserData> {
  try {
    const file = await getFile(root, `${STEMS_DIRNAME}/${USER_DATA_FILENAME}`);
    const parsed = JSON.parse(await file.text());
    return { version: 1, hotCues: parsed.hotCues ?? {} };
  } catch {
    return { version: 1, hotCues: {} }; // aún no has guardado nada: empezamos de cero
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
