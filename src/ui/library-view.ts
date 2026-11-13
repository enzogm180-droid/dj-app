/**
 * La parte VISUAL de la biblioteca: abrir tu carpeta de música, buscar
 * canciones y mandarlas al plato A o B.
 */
import { Library, lastFolder, pickFolder, reconnect, supportsFolders, type Track } from '../library/library';
import { useLibrary } from '../library/hotcue-store';
import { formatTime } from './deck-view';

export interface LibraryView {
  /** La biblioteca abierta ahora mismo (o null si aún no hay ninguna). */
  readonly library: Library | null;
  /** Vuelve a dibujar la lista (p. ej. cuando acabamos de calcular un BPM). */
  refresh(): void;
}

export function createLibraryView(
  root: HTMLElement,
  onLoad: (track: Track, library: Library, deck: 'A' | 'B') => void,
): LibraryView {
  root.classList.add('library');
  root.setAttribute('aria-label', 'Biblioteca');
  root.innerHTML = `
    <div class="library-bar">
      <button data-el="open">Abrir carpeta de música</button>
      <button data-el="reconnect" hidden></button>
      <span class="library-info" data-el="info">Elige la carpeta (o el pincho) donde está tu música.</span>
      <input type="search" data-el="search" placeholder="Buscar…" aria-label="Buscar canción" disabled />
    </div>
    <div class="library-list">
      <table>
        <thead><tr>
          <th data-sort="title"><button class="sort-btn" data-key="title">Título<span class="sort-arrow"></span></button></th>
          <th data-sort="bpm"><button class="sort-btn" data-key="bpm">BPM<span class="sort-arrow"></span></button></th>
          <th data-sort="duration"><button class="sort-btn" data-key="duration">Duración<span class="sort-arrow"></span></button></th>
          <th>Stems</th><th><span class="sr-only">Cargar</span></th>
        </tr></thead>
        <tbody data-el="rows"></tbody>
      </table>
    </div>
  `;

  const el = <T extends HTMLElement>(name: string) => root.querySelector(`[data-el="${name}"]`) as T;
  const openBtn = el<HTMLButtonElement>('open');
  const reconnectBtn = el<HTMLButtonElement>('reconnect');
  const info = el('info');
  const search = el<HTMLInputElement>('search');
  const rows = el<HTMLTableSectionElement>('rows');

  const view: { library: Library | null; refresh(): void } = { library: null, refresh: () => renderRows() };

  // --- Orden de la lista ---------------------------------------------------------
  // Clic en "Título", "BPM" o "Duración" = ordenar por esa columna.
  // Otro clic en la misma = al revés (▲ de menor a mayor, ▼ de mayor a menor).
  let order = loadOrder();
  const sortButtons = root.querySelectorAll<HTMLButtonElement>('.sort-btn');
  for (const btn of sortButtons) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key as SortKey;
      order = { key, dir: order.key === key ? (-order.dir as 1 | -1) : 1 };
      saveOrder(order);
      renderRows();
    });
  }

  /** Marca la columna por la que ordenamos (flechita + aviso para lectores de pantalla). */
  function showOrder(): void {
    for (const btn of sortButtons) {
      const active = btn.dataset.key === order.key;
      btn.querySelector('.sort-arrow')!.textContent = active ? (order.dir === 1 ? ' ▲' : ' ▼') : '';
      btn.parentElement!.setAttribute('aria-sort', active ? (order.dir === 1 ? 'ascending' : 'descending') : 'none');
    }
  }

  if (!supportsFolders()) {
    openBtn.disabled = true;
    info.textContent = 'Este navegador no permite abrir carpetas. Usa Chrome o Edge.';
    return view;
  }

  async function use(handle: FileSystemDirectoryHandle): Promise<void> {
    info.textContent = `Leyendo ${handle.name}…`;
    const library = await Library.open(handle);
    view.library = library;
    useLibrary(library); // los hot cues se guardan en esta carpeta (si hay permiso)
    reconnectBtn.hidden = true;
    search.disabled = false;
    const prepared = library.tracks.filter((t) => t.stems).length;
    const where = library.writable
      ? 'tus hot cues se guardan en la carpeta'
      : 'solo lectura: tus hot cues se guardan en este PC';
    info.textContent = `${library.name}: ${library.tracks.length} canciones · ${prepared} con stems · ${where}`;
    library.onSaveError = () => {
      info.textContent = `⚠ No se pudo guardar en "${library.name}". ¿Has quitado el pincho? Vuelve a abrir la carpeta.`;
    };
    renderRows();
  }

  function renderRows(): void {
    const library = view.library;
    if (!library) return;
    const query = search.value.trim().toLowerCase();
    const visible = sortTracks(
      library.tracks.filter((t) => `${t.title} ${t.artist} ${t.path}`.toLowerCase().includes(query)),
      order,
    );
    showOrder();

    rows.replaceChildren(
      ...visible.map((track) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><div class="lib-title"></div><div class="lib-artist"></div></td>
          <td class="num bpm-cell">${track.bpm ? track.bpm.toFixed(track.bpm % 1 ? 2 : 0) : '—'}</td>
          <td class="num">${track.duration ? formatTime(track.duration).replace(/\.\d$/, '') : '—'}</td>
          <td>${track.stems ? '<span class="badge">STEMS</span>' : '<span class="muted-text">—</span>'}</td>
          <td class="load-buttons">
            <button class="small" data-deck="A" aria-label="Cargar en el plato A">A</button>
            <button class="small" data-deck="B" aria-label="Cargar en el plato B">B</button>
          </td>`;
        // Texto con textContent (no innerHTML): así un nombre raro de archivo no rompe la página.
        tr.querySelector('.lib-title')!.textContent = track.title;
        tr.querySelector('.lib-artist')!.textContent = track.artist;
        for (const btn of tr.querySelectorAll<HTMLButtonElement>('[data-deck]')) {
          btn.addEventListener('click', () => onLoad(track, library, btn.dataset.deck as 'A' | 'B'));
        }
        return tr;
      }),
    );
  }

  openBtn.addEventListener('click', async () => {
    try {
      await use(await pickFolder());
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') {
        console.error(err);
        info.textContent = 'No se pudo abrir esa carpeta.';
      }
    }
  });

  search.addEventListener('input', renderRows);

  // ¿Recordamos una carpeta de la última vez?
  lastFolder().then((last) => {
    if (!last) return;
    if (last.granted) {
      use(last.handle);
      return;
    }
    // El navegador exige un clic para volver a dar permiso.
    reconnectBtn.hidden = false;
    reconnectBtn.textContent = `Volver a abrir "${last.handle.name}"`;
    reconnectBtn.addEventListener('click', async () => {
      if (await reconnect(last.handle)) await use(last.handle);
    });
  });

  return view;
}

// --- Ordenar -----------------------------------------------------------------------

type SortKey = 'title' | 'bpm' | 'duration';
/** Por qué columna ordenamos y en qué sentido (1 = de menor a mayor, −1 = al revés). */
interface SortOrder {
  key: SortKey;
  dir: 1 | -1;
}

const ORDER_STORAGE_KEY = 'dj-app:orden-biblioteca';

/**
 * Devuelve una copia ordenada (no cambia la lista original).
 * Las canciones SIN dato (p. ej. sin BPM porque aún no están preparadas) van
 * siempre al final, ordenes como ordenes: así no tapan las que sí lo tienen.
 * Si dos empatan (mismo BPM), se ordenan por título.
 */
function sortTracks(tracks: Track[], { key, dir }: SortOrder): Track[] {
  const byTitle = (a: Track, b: Track) => a.title.localeCompare(b.title, 'es', { numeric: true });
  return [...tracks].sort((a, b) => {
    if (key === 'title') return dir * byTitle(a, b);
    const va = a[key];
    const vb = b[key];
    if (!va && !vb) return byTitle(a, b);
    if (!va) return 1; // sin dato → al final
    if (!vb) return -1;
    return dir * (va - vb) || byTitle(a, b);
  });
}

/** El orden de la última vez (si el navegador lo guardó); si no, por título. */
function loadOrder(): SortOrder {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) ?? 'null');
    if (['title', 'bpm', 'duration'].includes(saved?.key) && (saved.dir === 1 || saved.dir === -1)) return saved;
  } catch {
    // almacenamiento bloqueado o dato estropeado: usamos el orden por defecto
  }
  return { key: 'title', dir: 1 };
}

function saveOrder(order: SortOrder): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // sin almacenamiento: simplemente no se recuerda para la próxima vez
  }
}
