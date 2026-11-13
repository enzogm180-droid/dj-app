/**
 * Punto de entrada de la app: monta los dos platos, el mixer y la
 * biblioteca, y los conecta.
 *
 *   Plato A → Efectos A ─┐
 *                        ├─ Mixer ─→ altavoces
 *   Plato B → Efectos B ─┘
 *       ↑
 *   Biblioteca (tu carpeta de música y sus stems)
 */
import './style.css';
import { Deck, setupDecks } from './audio/deck';
import { FxRack } from './audio/fx';
import { Mixer } from './audio/mixer';
import { createDeckView, deckSettings, type DeckView } from './ui/deck-view';
import { createLibraryView } from './ui/library-view';
import { createMidiView } from './ui/midi-view';
import { simulateMidi } from './midi/midi';
import { createMixerView } from './ui/mixer-view';
import { ScrollingWave } from './ui/scrolling-wave';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <h1>dj-app</h1>
    <button class="assist" id="assist" aria-pressed="true"
      title="Al dar PLAY con la otra canción sonando, arranca justo en su golpe. SYNC también cuadra los golpes.">
      Asistencia de golpe: ON
    </button>
    <button class="assist midi-btn" id="midi" title="Conectar la controladora (y abrir/cerrar el monitor MIDI)">MIDI</button>
    <span class="hint">A: Q play · W cue — B: P play · O cue — doble clic en un control = valor inicial</span>
  </header>
  <section id="midi-panel" aria-label="Monitor MIDI"></section>
  <section class="lanes" aria-label="Ondas de los dos platos">
    <div class="lane"><span class="lane-letter">A</span><canvas id="lane-a"></canvas></div>
    <div class="lane"><span class="lane-letter">B</span><canvas id="lane-b"></canvas></div>
    <div class="legend">
      <span><i style="background: var(--stem-vocals)"></i>Voces</span>
      <span><i style="background: var(--stem-other)"></i>Melodía</span>
      <span><i style="background: var(--stem-drums)"></i>Batería</span>
      <span><i style="background: var(--stem-bass)"></i>Bajo</span>
      <span><i style="background: var(--bass-mark)"></i>Booms (golpes graves)</span>
      <span><i style="background: var(--loop)"></i>Loop</span>
      <span><i style="background: rgba(255,255,255,0.35)"></i>Golpes</span>
      <span class="legend-hint">Arrastrar la onda = mover la canción · Rueda del ratón = zoom</span>
    </div>
  </section>
  <div class="console">
    <section id="deck-a"></section>
    <section id="mixer"></section>
    <section id="deck-b"></section>
  </div>
  <section id="library"></section>
`;

// Un único "motor de audio" (AudioContext) compartido por todo.
const ctx = new AudioContext();
await setupDecks(ctx); // prepara el key lock (mantener el tono al cambiar el tempo)
const mixer = new Mixer(ctx);
// Plato → efectos (3 ranuras) → canal del mixer. Los efectos con ritmo
// necesitan saber cuánto dura un golpe AHORA (BPM de la canción × tempo).
const beatSeconds = (deck: Deck | undefined) => (deck ? deck.beatLength / deck.tempo : 0.5);
const fxA = new FxRack(ctx, mixer.a.input, () => beatSeconds(deckA));
const fxB = new FxRack(ctx, mixer.b.input, () => beatSeconds(deckB));
const deckA: Deck = new Deck(ctx, fxA.input);
const deckB: Deck = new Deck(ctx, fxB.input);

const libraryView = createLibraryView(document.getElementById('library')!, (track, library, letter) => {
  const view = letter === 'A' ? viewA : viewB;
  view.load({
    title: track.title,
    artist: track.artist,
    load: async (deck) => {
      if (track.stems) {
        await deck.loadStems(await library.readStems(track), {
          id: track.stems.folder, // la huella del archivo: no cambia aunque lo renombres
          bpm: track.bpm,
          beat: track.beat,
          ...(await library.readLyrics(track)), // letra (de internet o de Whisper)
        });
      } else {
        await deck.load(await library.readTrack(track), {
          id: `ruta:${track.path}`,
          bpm: track.bpm,
          beat: track.beat,
        });
      }
      // Si la canción no tenía BPM guardado, apuntamos el que acaba de calcular el plato.
      if (track.bpm === null && deck.bpm !== null) {
        track.bpm = deck.bpm;
        libraryView.refresh();
      }
    },
  });
});

const getLibrary = () => libraryView.library;
const viewA: DeckView = createDeckView(document.getElementById('deck-a')!, 'A', deckA, deckB, fxA, getLibrary);
const viewB: DeckView = createDeckView(document.getElementById('deck-b')!, 'B', deckB, deckA, fxB, getLibrary);
createMixerView(document.getElementById('mixer')!, mixer, deckA, deckB);

// Solo mientras desarrollamos (npm run dev): deja los platos a mano en la
// consola del navegador (window.__dj) para poder hacer pruebas y medir.
// simulateMidi([0x90, 0x0B, 0x7F]) hace como si la controladora pulsara PLAY del plato A.
if (import.meta.env.DEV) Object.assign(window, { __dj: { deckA, deckB, mixer, simulateMidi } });

// Botón de asistencia de golpe (afecta a los dos platos).
const assistBtn = document.getElementById('assist') as HTMLButtonElement;
assistBtn.addEventListener('click', () => {
  deckSettings.assist = !deckSettings.assist;
  assistBtn.setAttribute('aria-pressed', String(deckSettings.assist));
  assistBtn.textContent = `Asistencia de golpe: ${deckSettings.assist ? 'ON' : 'OFF'}`;
});

// Controladora MIDI (botón "MIDI" de arriba + monitor).
createMidiView(document.getElementById('midi') as HTMLButtonElement, document.getElementById('midi-panel')!);

// Ondas grandes que avanzan con la canción (arriba del todo).
const laneA = new ScrollingWave(document.getElementById('lane-a') as HTMLCanvasElement, deckA);
const laneB = new ScrollingWave(document.getElementById('lane-b') as HTMLCanvasElement, deckB);
// Al soltar la onda tras arrastrarla, si sonaba, PLAY otra vez (con asistencia de golpe).
laneA.onResume = () => void viewA.toggle();
laneB.onResume = () => void viewB.toggle();

// --- Teclado ------------------------------------------------------------------
//   Plato A: Q = play/pausa, W = CUE (mantener)
//   Plato B: P = play/pausa, O = CUE (mantener)
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement && e.target.type !== 'range';

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  // Si estás escribiendo (p. ej. en el buscador), las teclas no controlan los platos.
  if (typing(e)) return;
  if (e.code === 'KeyQ') viewA.toggle();
  if (e.code === 'KeyP') viewB.toggle();
  if (e.code === 'KeyW') viewA.cueDown();
  if (e.code === 'KeyO') viewB.cueDown();
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW') viewA.cueUp();
  if (e.code === 'KeyO') viewB.cueUp();
});

// --- Bucle de pantalla: unas 60 veces por segundo actualiza los platos --------
function frame(): void {
  viewA.render();
  viewB.render();
  laneA.draw();
  laneB.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
