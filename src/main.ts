/**
 * Punto de entrada de la app: monta los dos platos, el mixer y la
 * biblioteca, y los conecta.
 *
 *   Plato A ─┐
 *            ├─ Mixer ─→ altavoces
 *   Plato B ─┘
 *       ↑
 *   Biblioteca (tu carpeta de música y sus stems)
 */
import './style.css';
import { Deck } from './audio/deck';
import { Mixer } from './audio/mixer';
import { createDeckView, type DeckView } from './ui/deck-view';
import { createLibraryView } from './ui/library-view';
import { createMixerView } from './ui/mixer-view';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <h1>dj-app</h1>
    <span class="hint">Q = play A · P = play B · doble clic en un control = valor inicial</span>
  </header>
  <div class="console">
    <section id="deck-a"></section>
    <section id="mixer"></section>
    <section id="deck-b"></section>
  </div>
  <section id="library"></section>
`;

// Un único "motor de audio" (AudioContext) compartido por todo.
const ctx = new AudioContext();
const mixer = new Mixer(ctx);
const deckA = new Deck(ctx, mixer.a.input);
const deckB = new Deck(ctx, mixer.b.input);

const libraryView = createLibraryView(document.getElementById('library')!, (track, library, letter) => {
  const view = letter === 'A' ? viewA : viewB;
  view.load({
    title: track.title,
    artist: track.artist,
    load: async (deck) => {
      if (track.stems) await deck.loadStems(await library.readStems(track));
      else await deck.load(await library.readTrack(track));
    },
  });
});

const getLibrary = () => libraryView.library;
const viewA: DeckView = createDeckView(document.getElementById('deck-a')!, 'A', deckA, getLibrary);
const viewB: DeckView = createDeckView(document.getElementById('deck-b')!, 'B', deckB, getLibrary);
createMixerView(document.getElementById('mixer')!, mixer, deckA, deckB);

// --- Teclado ------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  // Si estás escribiendo (p. ej. en el buscador), las teclas no controlan los platos.
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.code === 'KeyQ') viewA.toggle();
  if (e.code === 'KeyP') viewB.toggle();
});

// --- Bucle de pantalla: unas 60 veces por segundo actualiza los platos --------
function frame(): void {
  viewA.render();
  viewB.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
