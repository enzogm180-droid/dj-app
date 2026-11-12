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
        <thead><tr><th>Título</th><th>BPM</th><th>Duración</th><th>Stems</th><th><span class="sr-only">Cargar</span></th></tr></thead>
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
    const visible = library.tracks.filter((t) => `${t.title} ${t.artist} ${t.path}`.toLowerCase().includes(query));

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
