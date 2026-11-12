/**
 * Dónde se guardan los hot cues:
 *
 *  - Si tienes abierta tu carpeta de música (o el pincho) CON permiso para
 *    editarla → dentro de ella, en "_stems/mis-datos.json". Viajan con el
 *    pincho a cualquier portátil.
 *  - Si no (sin carpeta abierta, o solo con permiso de lectura) → en el
 *    navegador de este PC, como antes. Funcionan, pero no viajan.
 *
 * Además, si una canción tenía hot cues guardados en el navegador (de antes
 * de este cambio) y ahora la cargas desde la carpeta, se PASAN a la carpeta
 * solos y se borran del navegador.
 */
import type { Library } from './library';

let library: Library | null = null;

/** La biblioteca abierta ahora mismo (la llama la vista de la biblioteca). */
export function useLibrary(lib: Library | null): void {
  library = lib;
}

/** ¿Se están guardando en la carpeta? (para enseñarlo en pantalla) */
export function savingToFolder(): boolean {
  return library?.writable ?? false;
}

const browserKey = (id: string) => `dj-app:hotcues:${id}`;

function readBrowser(id: string): (number | null)[] | null {
  try {
    const saved = JSON.parse(localStorage.getItem(browserKey(id)) ?? 'null');
    return Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

function writeBrowser(id: string, cues: (number | null)[]): void {
  try {
    if (cues.every((c) => c === null)) localStorage.removeItem(browserKey(id));
    else localStorage.setItem(browserKey(id), JSON.stringify(cues));
  } catch {
    // Si el navegador no deja guardar (modo privado…), simplemente no se recuerdan.
  }
}

/** Deja la lista con exactamente `count` huecos (número o vacío). */
function normalize(saved: unknown[] | null, count: number): (number | null)[] {
  return Array.from({ length: count }, (_, i) => (typeof saved?.[i] === 'number' ? (saved[i] as number) : null));
}

/** Hot cues guardados de una canción. */
export function loadHotCues(id: string | null, count: number): (number | null)[] {
  if (!id) return normalize(null, count);
  const fromFolder = library?.getHotCues(id);
  if (fromFolder) return normalize(fromFolder, count);

  const fromBrowser = readBrowser(id);
  if (fromBrowser && library?.writable) {
    // Mudanza: del navegador a la carpeta.
    library.setHotCues(id, normalize(fromBrowser, count));
    try {
      localStorage.removeItem(browserKey(id));
    } catch {
      // da igual: la copia buena ya está en la carpeta
    }
  }
  return normalize(fromBrowser, count);
}

/** Guarda los hot cues de una canción, en la carpeta si se puede. */
export function saveHotCues(id: string | null, cues: (number | null)[]): void {
  if (!id) return;
  if (library?.writable) library.setHotCues(id, cues);
  else writeBrowser(id, cues);
}
