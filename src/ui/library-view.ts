/**
 * La parte VISUAL de la biblioteca: abrir tu carpeta de música, buscar
 * canciones y mandarlas al plato A o B.
 */
import { Library, lastFolder, pickFolder, reconnect, supportsFolders, type Track } from '../library/library';
import { useLibrary } from '../library/hotcue-store';
import { formatTime } from './deck-view';
import { registerControl } from '../midi/controls';
import { introDone } from './intro';
import { programMusicFolder } from '../library/program-folder';

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
    <div class="genre-tabs" data-el="tabs" role="tablist" aria-label="Géneros" hidden></div>
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
  const tabs = el('tabs');

  const view: { library: Library | null; refresh(): void } = { library: null, refresh: () => renderRows() };

  // --- Pestañas de géneros ----------------------------------------------------------
  // Encima de la lista, como las pestañas del navegador: "Todas", "Reggaetón",
  // "Trap"… Al elegir una, la lista (y el buscador) solo enseñan ese género.
  // Los géneros salen de "_stems/generos.json" (tools/preparador/clasificar_generos.py).
  let activeGenre = loadActiveGenre();

  function renderTabs(): void {
    const library = view.library;
    if (!library || !library.genres.length) {
      tabs.hidden = true;
      activeGenre = ALL;
      return;
    }
    // Si la pestaña guardada ya no existe (p. ej. otra carpeta), volvemos a "Todas".
    if (activeGenre !== ALL && !library.genres.some((g) => g.id === activeGenre)) activeGenre = ALL;
    const options = [
      { id: ALL, name: 'Todas', count: library.tracks.length },
      ...library.genres.map((g) => ({ id: g.id, name: g.name, count: library.tracks.filter((t) => library.inGenre(t, g)).length })),
    ];
    tabs.hidden = false;
    tabs.replaceChildren(
      ...options.map(({ id, name, count }) => {
        const tab = document.createElement('button');
        tab.className = 'genre-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(id === activeGenre));
        tab.innerHTML = `<span class="genre-name"></span><span class="genre-count">${count}</span>`;
        tab.querySelector('.genre-name')!.textContent = name;
        tab.addEventListener('click', () => {
          activeGenre = id;
          saveActiveGenre(id);
          selected = 0;
          renderTabs();
          renderRows();
        });
        return tab;
      }),
    );
  }

  // --- Canción elegida con la controladora --------------------------------------
  // La rueda del navegador de la mesa mueve una "selección" por la lista y los
  // botones LOAD cargan la canción seleccionada en su plato.
  let visibleTracks: Track[] = [];
  let selected = 0;

  function showSelection(scroll: boolean): void {
    [...rows.children].forEach((tr, i) => {
      tr.classList.toggle('selected', i === selected);
      tr.setAttribute('aria-selected', String(i === selected));
      if (scroll && i === selected) tr.scrollIntoView({ block: 'nearest' });
    });
  }

  registerControl('browse', {
    turn: (delta) => {
      if (!visibleTracks.length) return;
      selected = Math.min(visibleTracks.length - 1, Math.max(0, selected + delta));
      showSelection(true);
    },
  });
  for (const letter of ['A', 'B'] as const) {
    registerControl(`${letter}.load`, {
      press: (down) => {
        const track = visibleTracks[selected];
        if (down && track && view.library) onLoad(track, view.library, letter);
      },
    });
  }

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
    console.info(`Biblioteca abierta: ${info.textContent}`); // (para ver en el registro que se abrió bien)
    library.onSaveError = () => {
      info.textContent = `⚠ No se pudo guardar en "${library.name}". ¿Has quitado el pincho? Vuelve a abrir la carpeta.`;
    };
    renderTabs();
    renderRows();
  }

  function renderRows(): void {
    const library = view.library;
    if (!library) return;
    const query = search.value.trim().toLowerCase();
    const genre = library.genres.find((g) => g.id === activeGenre) ?? null;
    const visible = sortTracks(
      library.tracks.filter(
        (t) =>
          (!genre || library.inGenre(t, genre)) && // solo las de la pestaña elegida
          `${t.title} ${t.artist} ${t.path}`.toLowerCase().includes(query),
      ),
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
        // Clic en la fila (no en A/B) = seleccionarla, para cargarla luego con LOAD de la mesa.
        tr.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          selected = visibleTracks.indexOf(track);
          showSelection(false);
        });
        return tr;
      }),
    );
    visibleTracks = visible;
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    showSelection(false);
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

  // En el PROGRAMA Stemzo: abrimos sola la carpeta "musica separada" de su mismo
  // disco (sin elegirla). En Chrome, o si no la encuentra, la de la última vez.
  // Esperamos a que acabe la animación de inicio: leer la carpeta ocupa al
  // ordenador un momento y, mientras, la animación se quedaría congelada.
  void (async () => {
    const auto = await programMusicFolder();
    if (auto) {
      await introDone;
      try {
        await use(auto);
        return;
      } catch (err) {
        console.error('No se pudo leer la carpeta de música', err);
      }
    }
    rememberedFolder();
  })();

  /** ¿Recordamos una carpeta de la última vez? */
  function rememberedFolder(): void {
    lastFolder().then(async (last) => {
      if (!last) return;
      if (last.granted) {
        await introDone; // (igual: sin congelar la animación de inicio)
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
  }

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

// --- Pestaña de género recordada -----------------------------------------------------

/** La pestaña "Todas" (no es un género). */
const ALL = 'todas';
const GENRE_STORAGE_KEY = 'dj-app:pestana-genero';

function loadActiveGenre(): string {
  try {
    return localStorage.getItem(GENRE_STORAGE_KEY) ?? ALL;
  } catch {
    return ALL;
  }
}

function saveActiveGenre(id: string): void {
  try {
    localStorage.setItem(GENRE_STORAGE_KEY, id);
  } catch {
    // sin almacenamiento: no se recuerda, no pasa nada
  }
}

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
