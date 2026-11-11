/**
 * Punto de entrada de la app: monta los dos platos y el mixer y los conecta.
 *
 *   Plato A ─┐
 *            ├─ Mixer ─→ altavoces
 *   Plato B ─┘
 */
import './style.css';
import { Deck } from './audio/deck';
import { Mixer } from './audio/mixer';
import { createDeckView } from './ui/deck-view';
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
`;

// Un único "motor de audio" (AudioContext) compartido por todo.
const ctx = new AudioContext();
const mixer = new Mixer(ctx);
const deckA = new Deck(ctx, mixer.a.input);
const deckB = new Deck(ctx, mixer.b.input);

const viewA = createDeckView(document.getElementById('deck-a')!, 'A', deckA);
const viewB = createDeckView(document.getElementById('deck-b')!, 'B', deckB);
createMixerView(document.getElementById('mixer')!, mixer);

// --- Teclado ------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
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
