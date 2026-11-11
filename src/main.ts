/**
 * Punto de entrada de la app: crea la interfaz del plato y la conecta con
 * el motor de audio (Deck) y el dibujo de la onda (Waveform).
 */
import './style.css';
import { Deck } from './audio/deck';
import { Waveform } from './ui/waveform';

/** Rango del pitch: ±8 %, el valor típico de los platos de DJ. */
const PITCH_RANGE = 8;

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <h1>dj-app</h1>
    <span class="hint">Espacio = play/pausa</span>
  </header>

  <section class="deck" aria-label="Plato A">
    <div class="deck-head">
      <span class="deck-letter">A</span>
      <div class="track">
        <div class="track-title" id="title">Sin canción</div>
        <div class="track-time"><span id="time">0:00.0</span> / <span id="duration">0:00.0</span></div>
      </div>
      <label class="load">
        Cargar canción
        <input type="file" id="file" accept="audio/*" hidden />
      </label>
    </div>

    <canvas class="wave" id="wave"></canvas>

    <div class="controls">
      <button class="play" id="play" disabled aria-label="Play">▶</button>

      <div class="pitch">
        <label for="pitch">Pitch <output id="pitch-value">0.0 %</output></label>
        <input type="range" id="pitch" min="${-PITCH_RANGE}" max="${PITCH_RANGE}" step="0.1" value="0" />
        <button class="small" id="pitch-reset">Reset</button>
      </div>
    </div>
  </section>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const playBtn = $<HTMLButtonElement>('play');
const pitchInput = $<HTMLInputElement>('pitch');
const pitchValue = $<HTMLOutputElement>('pitch-value');
const pitchReset = $<HTMLButtonElement>('pitch-reset');
const titleEl = $('title');
const timeEl = $('time');
const durationEl = $('duration');

const deck = new Deck(new AudioContext());
const waveform = new Waveform($<HTMLCanvasElement>('wave'));

/** Convierte segundos en texto "m:ss.d", p. ej. 83.4 → "1:23.4". */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function updatePlayButton(): void {
  playBtn.textContent = deck.isPlaying ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', deck.isPlaying ? 'Pausa' : 'Play');
  playBtn.classList.toggle('on', deck.isPlaying);
}

function setPitch(percent: number): void {
  pitchInput.value = String(percent);
  pitchValue.textContent = `${percent > 0 ? '+' : ''}${percent.toFixed(1)} %`;
  deck.setRate(1 + percent / 100);
}

// --- Cargar canción ---------------------------------------------------------
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  titleEl.textContent = `Cargando ${file.name}…`;
  playBtn.disabled = true;
  try {
    const buffer = await deck.load(file);
    waveform.setBuffer(buffer);
    titleEl.textContent = file.name.replace(/\.[^.]+$/, '');
    durationEl.textContent = formatTime(buffer.duration);
    playBtn.disabled = false;
  } catch {
    titleEl.textContent = 'No se pudo leer ese archivo. Prueba con un MP3 o WAV.';
  }
  updatePlayButton();
  fileInput.value = ''; // permite volver a cargar el mismo archivo
});

// --- Play / pausa -----------------------------------------------------------
playBtn.addEventListener('click', async () => {
  await deck.toggle();
  updatePlayButton();
});

window.addEventListener('keydown', async (e) => {
  if (e.code !== 'Space' || !deck.loaded) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  e.preventDefault(); // que la barra espaciadora no haga scroll ni pulse botones
  await deck.toggle();
  updatePlayButton();
});

deck.onEnded = updatePlayButton;

// --- Saltar al hacer clic en la onda ----------------------------------------
waveform.onSeek = (fraction) => deck.seek(fraction * deck.duration);

// --- Pitch --------------------------------------------------------------------
pitchInput.addEventListener('input', () => setPitch(Number(pitchInput.value)));
pitchInput.addEventListener('dblclick', () => setPitch(0));
pitchReset.addEventListener('click', () => setPitch(0));

// --- Bucle de pantalla: unas 60 veces por segundo actualiza onda y tiempo -----
function frame(): void {
  const position = deck.position;
  timeEl.textContent = formatTime(position);
  waveform.draw(deck.duration ? position / deck.duration : 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
