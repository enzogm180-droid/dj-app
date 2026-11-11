/**
 * La parte VISUAL de un plato: título, tiempos, onda, play/pausa y pitch.
 *
 * Es una función que sirve para cualquier plato: la llamamos una vez para
 * el A y otra para el B, cada una con su propio Deck (motor de audio).
 */
import type { Deck } from '../audio/deck';
import { Waveform } from './waveform';

/** Rango del pitch: ±8 %, el valor típico de los platos de DJ. */
const PITCH_RANGE = 8;

export interface DeckView {
  /** Play/pausa desde fuera (por ejemplo, desde el teclado). */
  toggle(): Promise<void>;
  /** Refresca onda y tiempo; se llama unas 60 veces por segundo. */
  render(): void;
}

/** Convierte segundos en texto "m:ss.d", p. ej. 83.4 → "1:23.4". */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function createDeckView(root: HTMLElement, letter: string, deck: Deck): DeckView {
  root.classList.add('deck');
  root.setAttribute('aria-label', `Plato ${letter}`);
  root.innerHTML = `
    <div class="deck-head">
      <span class="deck-letter">${letter}</span>
      <div class="track">
        <div class="track-title" data-el="title">Sin canción</div>
        <div class="track-time"><span data-el="time">0:00.0</span> / <span data-el="duration">0:00.0</span></div>
      </div>
      <label class="load">
        Cargar
        <input type="file" data-el="file" accept="audio/*" hidden />
      </label>
    </div>

    <canvas class="wave" data-el="wave"></canvas>

    <div class="controls">
      <button class="play" data-el="play" disabled aria-label="Play">▶</button>
      <div class="pitch">
        <label>Pitch <output data-el="pitch-value">0.0 %</output></label>
        <input type="range" data-el="pitch" min="${-PITCH_RANGE}" max="${PITCH_RANGE}" step="0.1" value="0"
          aria-label="Pitch del plato ${letter}" />
        <button class="small" data-el="pitch-reset">Reset</button>
      </div>
    </div>
  `;

  // Buscamos cada elemento DENTRO de este plato (así A y B no se mezclan).
  const el = <T extends HTMLElement>(name: string) => root.querySelector(`[data-el="${name}"]`) as T;
  const fileInput = el<HTMLInputElement>('file');
  const playBtn = el<HTMLButtonElement>('play');
  const pitchInput = el<HTMLInputElement>('pitch');
  const pitchValue = el<HTMLOutputElement>('pitch-value');
  const titleEl = el('title');
  const timeEl = el('time');
  const durationEl = el('duration');
  const waveform = new Waveform(el<HTMLCanvasElement>('wave'));

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

  async function toggle(): Promise<void> {
    if (!deck.loaded) return;
    await deck.toggle();
    updatePlayButton();
  }

  // --- Cargar canción -------------------------------------------------------
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

  playBtn.addEventListener('click', toggle);
  deck.onEnded = updatePlayButton;
  waveform.onSeek = (fraction) => deck.seek(fraction * deck.duration);

  pitchInput.addEventListener('input', () => setPitch(Number(pitchInput.value)));
  pitchInput.addEventListener('dblclick', () => setPitch(0));
  el('pitch-reset').addEventListener('click', () => setPitch(0));

  return {
    toggle,
    render() {
      const position = deck.position;
      timeEl.textContent = formatTime(position);
      waveform.draw(deck.duration ? position / deck.duration : 0);
    },
  };
}
