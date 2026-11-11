/**
 * La parte VISUAL de un plato: título, tiempos, onda, play/pausa, pitch y
 * los pads de stems.
 *
 * Es una función que sirve para cualquier plato: la llamamos una vez para
 * el A y otra para el B, cada una con su propio Deck (motor de audio).
 */
import type { Deck, StemName } from '../audio/deck';
import type { Library } from '../library/library';
import { Waveform } from './waveform';

/** Rango del pitch: ±8 %, el valor típico de los platos de DJ. */
const PITCH_RANGE = 8;

const PADS: { stem: StemName; label: string }[] = [
  { stem: 'vocals', label: 'Voces' },
  { stem: 'other', label: 'Melodía' },
  { stem: 'bass', label: 'Bajo' },
  { stem: 'drums', label: 'Batería' },
];

/** Qué cargar en el plato: un nombre para mostrar y una función que lo carga. */
export interface LoadRequest {
  title: string;
  artist: string;
  load: (deck: Deck) => Promise<void>;
}

export interface DeckView {
  /** Play/pausa desde fuera (por ejemplo, desde el teclado). */
  toggle(): Promise<void>;
  /** Carga una canción (desde la biblioteca o desde un archivo). */
  load(request: LoadRequest): Promise<void>;
  /** Refresca onda y tiempo; se llama unas 60 veces por segundo. */
  render(): void;
}

/** Convierte segundos en texto "m:ss.d", p. ej. 83.4 → "1:23.4". */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function createDeckView(
  root: HTMLElement,
  letter: string,
  deck: Deck,
  getLibrary: () => Library | null,
): DeckView {
  root.classList.add('deck');
  root.setAttribute('aria-label', `Plato ${letter}`);
  root.innerHTML = `
    <div class="deck-head">
      <span class="deck-letter">${letter}</span>
      <div class="track">
        <div class="track-title"><span class="track-name" data-el="title">Sin canción</span><span class="badge" data-el="badge" hidden>STEMS</span></div>
        <div class="track-artist" data-el="artist"></div>
      </div>
      <div class="track-time">
        <span data-el="time">0:00.0</span>
        <span class="remaining" data-el="remaining">-0:00.0</span>
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

    <div class="pads" role="group" aria-label="Stems del plato ${letter}">
      ${PADS.map(({ stem, label }) => `<button class="pad" data-stem="${stem}" disabled aria-pressed="true">${label}</button>`).join('')}
    </div>
  `;

  // Buscamos cada elemento DENTRO de este plato (así A y B no se mezclan).
  const el = <T extends HTMLElement>(name: string) => root.querySelector(`[data-el="${name}"]`) as T;
  const fileInput = el<HTMLInputElement>('file');
  const playBtn = el<HTMLButtonElement>('play');
  const pitchInput = el<HTMLInputElement>('pitch');
  const pitchValue = el<HTMLOutputElement>('pitch-value');
  const titleEl = el('title');
  const artistEl = el('artist');
  const badge = el('badge');
  const timeEl = el('time');
  const remainingEl = el('remaining');
  const pads = [...root.querySelectorAll<HTMLButtonElement>('.pad')];
  const waveform = new Waveform(el<HTMLCanvasElement>('wave'));

  function updatePlayButton(): void {
    playBtn.textContent = deck.isPlaying ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', deck.isPlaying ? 'Pausa' : 'Play');
    playBtn.classList.toggle('on', deck.isPlaying);
  }

  function updatePads(): void {
    for (const pad of pads) {
      const stem = pad.dataset.stem as StemName;
      const on = deck.hasStems && !deck.isStemMuted(stem);
      pad.disabled = !deck.hasStems;
      pad.classList.toggle('muted', deck.hasStems && !on);
      pad.setAttribute('aria-pressed', String(on));
    }
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

  async function load(request: LoadRequest): Promise<void> {
    titleEl.textContent = `Cargando ${request.title}…`;
    artistEl.textContent = '';
    playBtn.disabled = true;
    try {
      await request.load(deck);
      waveform.setBuffers(deck.buffers);
      titleEl.textContent = request.title;
      artistEl.textContent = request.artist;
      playBtn.disabled = false;
    } catch (err) {
      console.error(err);
      titleEl.textContent = 'No se pudo leer esa canción. Prueba con un MP3 o WAV.';
    }
    updatePlayButton();
  }

  // --- Cargar canción desde un archivo ------------------------------------------
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // permite volver a cargar el mismo archivo
    if (!file) return;
    await load({
      title: file.name.replace(/\.[^.]+$/, ''),
      artist: '',
      async load(d) {
        const data = await file.arrayBuffer();
        // Si hay biblioteca abierta y esta canción está preparada, usamos sus stems.
        const library = getLibrary();
        const track = library && (await library.findByContent(data));
        if (library && track) await d.loadStems(await library.readStems(track));
        else await d.load(data);
      },
    });
  });

  playBtn.addEventListener('click', toggle);
  waveform.onSeek = (fraction) => deck.seek(fraction * deck.duration);

  pitchInput.addEventListener('input', () => setPitch(Number(pitchInput.value)));
  pitchInput.addEventListener('dblclick', () => setPitch(0));
  el('pitch-reset').addEventListener('click', () => setPitch(0));

  for (const pad of pads) {
    pad.addEventListener('click', () => deck.toggleStemMute(pad.dataset.stem as StemName));
  }

  // El motor nos avisa cuando algo cambia.
  deck.addEventListener('ended', updatePlayButton);
  deck.addEventListener('stems', updatePads);
  deck.addEventListener('loaded', () => {
    badge.hidden = !deck.hasStems;
    updatePads();
  });

  return {
    toggle,
    load,
    render() {
      const position = deck.position;
      timeEl.textContent = formatTime(position);
      remainingEl.textContent = `-${formatTime(Math.max(0, deck.duration - position))}`;
      waveform.draw(deck.duration ? position / deck.duration : 0);
    },
  };
}
