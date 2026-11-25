/**
 * La carpeta de música LEÍDA POR EL PROGRAMA Stemzo (sin tener que elegirla).
 *
 * En Chrome, la única forma de leer una carpeta es que tú la elijas con
 * "Abrir carpeta de música": el navegador nos da entonces un "handle" (un
 * mando para esa carpeta) y la biblioteca (library.ts) trabaja con él.
 *
 * En el programa Stemzo no hace falta elegirla: el programa busca solo
 * "musica separada" en su mismo disco (electron/main.cjs) y nos deja leerla.
 * Aquí fabricamos un mando que se comporta IGUAL que el del navegador (las
 * mismas funciones: listar, abrir subcarpetas, leer y escribir archivos), pero
 * que por dentro le pide cada cosa al programa. Así la biblioteca no tiene que
 * cambiar nada: no sabe si la carpeta la elegiste tú o la encontró Stemzo.
 */

/** Lo que nos da el programa (ver electron/preload.cjs). */
interface ProgramMusic {
  buscar(): Promise<string | null>;
  listar(ruta: string): Promise<{ name: string; kind: 'file' | 'directory' }[]>;
  tipo(ruta: string): Promise<'file' | 'directory' | null>;
  leer(ruta: string): Promise<Uint8Array>;
  crearCarpeta(ruta: string): Promise<void>;
  escribir(ruta: string, datos: string | Uint8Array): Promise<void>;
}

function programMusic(): ProgramMusic | null {
  return (window as Window & { stemzo?: { musica?: ProgramMusic } }).stemzo?.musica ?? null;
}

/** Une una ruta de carpeta con un nombre: "" + "_stems" → "_stems"; "_stems" + "a.json" → "_stems/a.json". */
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** El mismo error que da el navegador cuando algo no existe. */
const notFound = (path: string) => new DOMException(`No existe: ${path}`, 'NotFoundError');

/** Un ARCHIVO de la carpeta de música. */
class ProgramFileHandle {
  readonly kind = 'file';
  constructor(
    private readonly music: ProgramMusic,
    private readonly path: string,
    readonly name: string,
  ) {}

  async getFile(): Promise<File> {
    const data = await this.music.leer(this.path);
    return new File([data as Uint8Array<ArrayBuffer>], this.name);
  }

  /** Para escribir: vamos juntando lo que nos dan y al cerrar se guarda de golpe. */
  async createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }> {
    const parts: (string | Uint8Array)[] = [];
    return {
      write: async (data) => void parts.push(data),
      close: async () => {
        const text = parts.every((p) => typeof p === 'string');
        const data = text ? parts.join('') : new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
        await this.music.escribir(this.path, data);
      },
    };
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

/** Una CARPETA (la de música o cualquiera de dentro). */
class ProgramDirectoryHandle {
  readonly kind = 'directory';
  constructor(
    private readonly music: ProgramMusic,
    private readonly path: string,
    readonly name: string,
  ) {}

  /** Lo que hay dentro (subcarpetas y archivos), uno a uno. */
  async *values(): AsyncGenerator<ProgramDirectoryHandle | ProgramFileHandle> {
    for (const entry of await this.music.listar(this.path)) {
      const path = join(this.path, entry.name);
      yield entry.kind === 'directory'
        ? new ProgramDirectoryHandle(this.music, path, entry.name)
        : new ProgramFileHandle(this.music, path, entry.name);
    }
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProgramDirectoryHandle> {
    const path = join(this.path, name);
    const kind = await this.music.tipo(path);
    if (kind !== 'directory') {
      if (!options?.create || kind) throw notFound(path);
      await this.music.crearCarpeta(path);
    }
    return new ProgramDirectoryHandle(this.music, path, name);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<ProgramFileHandle> {
    const path = join(this.path, name);
    const kind = await this.music.tipo(path);
    if (kind !== 'file' && (!options?.create || kind)) throw notFound(path);
    // (Si hay que crearlo, se crea al escribir en él.)
    return new ProgramFileHandle(this.music, path, name);
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

/**
 * Si estamos en el programa Stemzo y encuentra la carpeta "musica separada",
 * devuelve su mando (listo para la biblioteca). Si no, null: entonces la
 * carpeta se elige a mano, como en Chrome.
 */
export async function programMusicFolder(): Promise<FileSystemDirectoryHandle | null> {
  const music = programMusic();
  if (!music) return null;
  const found = await music.buscar();
  if (!found) return null;
  const name = found.split(/[\\/]/).filter(Boolean).pop() ?? found;
  // El mando tiene las mismas funciones que el del navegador que usa la
  // biblioteca; para TypeScript le decimos que lo trate como tal.
  return new ProgramDirectoryHandle(music, '', name) as unknown as FileSystemDirectoryHandle;
}
