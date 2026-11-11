/**
 * La parte VISUAL de un plato: título, BPM, tiempos, onda, play/pausa,
 * tempo y los pads de stems.
 *
 * Es una función que sirve para cualquier plato: la llamamos una vez para
 * el A y otra para el B, cada una con su propio Deck (motor de audio).
 */
import type { Deck, StemName } from '../audio/deck';
import type { Library } from '../library/library';
import { Waveform } from './waveform';

/**
 * Rangos del fader de tempo (en %). El botón "±8%" va pasando de uno a otro.
 * ±8 % es lo típico y da más precisión; los grandes sirven para juntar
 * canciones con BPM muy distintos.
 */
const TEMPO_RANGES = [8, 16, 33, 50];

/** Velocidad del SYNC: cuánto tempo cambia por segundo (en %). */
const SYNC_SPEED = 2;

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
  /** Botón CUE desde fuera (teclado): pulsar y soltar. */
  cueDown(): void;
  cueUp(): void;
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

/** BPM con 2 decimales: "124.00". */
function formatBpm(bpm: number | null): string {
  return bpm === null ? '—' : bpm.toFixed(2);
}

export function createDeckView(
  root: HTMLElement,
  letter: string,
  deck: Deck,
  /** El otro plato: el que ya suena, al que nos sincronizamos con SYNC. */
  other: Deck,
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
      <div class="bpm-box" title="BPM actual (y el original de la canción)">
        <span class="bpm" data-el="bpm">—</span>
        <span class="bpm-orig" data-el="bpm-orig">BPM</span>
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
      <div class="transport">
        <button class="cue" data-el="cue" disabled title="Mantén pulsado para escuchar; al soltar vuelve al punto CUE">CUE</button>
        <button class="play" data-el="play" disabled aria-label="Play">▶</button>
        <button class="sync" data-el="sync" disabled title="Iguala poco a poco el BPM al del otro plato">SYNC</button>
      </div>
      <div class="tempo">
        <label>Tempo <output data-el="tempo-value">0.0 %</output></label>
        <input type="range" data-el="tempo" min="${-TEMPO_RANGES[0]}" max="${TEMPO_RANGES[0]}" step="0.05" value="0"
          aria-label="Tempo del plato ${letter}" />
        <button class="small" data-el="tempo-range" title="Rango del fader de tempo">±${TEMPO_RANGES[0]}%</button>
        <button class="small" data-el="tempo-reset">Reset</button>
      </div>
    </div>

    <div class="pads" role="group" aria-label="Stems del plato ${letter}">
      ${PADS.map(({ stem, label }) => `<button class="pad" data-stem="${stem}" disabled aria-pressed="false">${label}</button>`).join('')}
      <button class="pad mode-pad" data-el="acapella" disabled aria-pressed="false">Acapella</button>
      <button class="pad mode-pad" data-el="instrumental" disabled aria-pressed="false">Instrumental</button>
    </div>
  `;

  // Buscamos cada elemento DENTRO de este plato (así A y B no se mezclan).
  const el = <T extends HTMLElement>(name: string) => root.querySelector(`[data-el="${name}"]`) as T;
  const fileInput = el<HTMLInputElement>('file');
  const playBtn = el<HTMLButtonElement>('play');
  const cueBtn = el<HTMLButtonElement>('cue');
  const syncBtn = el<HTMLButtonElement>('sync');
  const rangeBtn = el<HTMLButtonElement>('tempo-range');
  const tempoInput = el<HTMLInputElement>('tempo');
  const tempoValue = el<HTMLOutputElement>('tempo-value');
  const titleEl = el('title');
  const artistEl = el('artist');
  const badge = el('badge');
  const bpmEl = el('bpm');
  const bpmOrigEl = el('bpm-orig');
  const timeEl = el('time');
  const remainingEl = el('remaining');
  const pads = [...root.querySelectorAll<HTMLButtonElement>('.pad[data-stem]')];
  const acapellaBtn = el<HTMLButtonElement>('acapella');
  const instrumentalBtn = el<HTMLButtonElement>('instrumental');
  const waveform = new Waveform(el<HTMLCanvasElement>('wave'));

  function updatePlayButton(): void {
    playBtn.textContent = deck.isPlaying ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', deck.isPlaying ? 'Pausa' : 'Play');
    playBtn.classList.toggle('on', deck.isPlaying);
  }

  function updatePads(): void {
    for (const pad of pads) {
      const on = deck.hasStems && deck.isStemOn(pad.dataset.stem as StemName);
      pad.disabled = !deck.hasStems;
      pad.classList.toggle('muted', deck.hasStems && !on);
      pad.setAttribute('aria-pressed', String(on));
    }
    const acapella = deck.hasStems && deck.isOnly(['vocals']);
    const instrumental = deck.hasStems && deck.isOnly(['other', 'bass', 'drums']);
    acapellaBtn.disabled = instrumentalBtn.disabled = !deck.hasStems;
    acapellaBtn.classList.toggle('active', acapella);
    acapellaBtn.setAttribute('aria-pressed', String(acapella));
    instrumentalBtn.classList.toggle('active', instrumental);
    instrumentalBtn.setAttribute('aria-pressed', String(instrumental));
  }

  function updateBpm(): void {
    bpmEl.textContent = formatBpm(deck.currentBpm);
    bpmOrigEl.textContent = deck.bpm !== null && deck.tempo !== 1 ? `orig. ${formatBpm(deck.bpm)}` : 'BPM';
    bpmEl.classList.toggle('changed', deck.tempo !== 1);
  }

  // --- Tempo ---------------------------------------------------------------------
  let range = TEMPO_RANGES[0];

  function setRange(next: number): void {
    range = next;
    tempoInput.min = String(-range);
    tempoInput.max = String(range);
    rangeBtn.textContent = `±${range}%`;
    // Si el tempo actual no cabe en el rango nuevo, lo recortamos al borde.
    const pct = (deck.tempo - 1) * 100;
    if (Math.abs(pct) > range) deck.setTempo(1 + (Math.sign(pct) * range) / 100);
    showTempo();
  }

  /** Coloca el fader y los textos según el tempo real del plato. */
  function showTempo(): void {
    const pct = (deck.tempo - 1) * 100;
    tempoInput.value = String(pct);
    tempoValue.textContent = `${pct > 0.005 ? '+' : ''}${pct.toFixed(1)} %`;
    updateSync();
    updateBpm();
  }

  function setTempo(percent: number): void {
    deck.setTempo(1 + percent / 100);
  }

  // --- SYNC ----------------------------------------------------------------------

  /**
   * El BPM del otro plato al que deberíamos ir. Si la diferencia es muy grande,
   * probamos también la mitad y el doble (147 BPM encaja con 73,5): se elige
   * el que pide cambiar menos el tempo.
   */
  function syncTarget(): number | null {
    if (deck.bpm === null || other.currentBpm === null) return null;
    const target = other.currentBpm;
    const options = [target, target / 2, target * 2];
    const bpm = deck.bpm;
    return options.reduce((a, b) => (Math.abs(Math.log(b / bpm)) < Math.abs(Math.log(a / bpm)) ? b : a));
  }

  function sync(): void {
    const target = syncTarget();
    if (target === null || deck.bpm === null) return;
    const rate = target / deck.bpm;
    const pct = Math.abs(rate - 1) * 100;
    // Si hace falta más rango, lo ampliamos solo.
    if (pct > range) setRange(TEMPO_RANGES.find((r) => r >= pct) ?? TEMPO_RANGES[TEMPO_RANGES.length - 1]);
    const finalRate = 1 + (Math.sign(rate - 1) * Math.min(pct, range)) / 100;
    // Poco a poco: SYNC_SPEED % por segundo (mínimo 1 s, máximo 8 s).
    const change = Math.abs(finalRate - deck.tempo) * 100;
    const seconds = Math.min(8, Math.max(1, change / SYNC_SPEED));
    deck.glideTempo(finalRate, seconds * 1000);
  }

  /** ¿Están ya los dos platos al mismo BPM? (para encender el botón SYNC) */
  function inSync(): boolean {
    const target = syncTarget();
    return target !== null && deck.currentBpm !== null && Math.abs(deck.currentBpm - target) < 0.02;
  }

  /** SYNC: se puede usar si los dos platos tienen BPM; se enciende si ya están igualados. */
  function updateSync(): void {
    syncBtn.disabled = syncTarget() === null;
    syncBtn.classList.toggle('on', !deck.isGliding && inSync());
    syncBtn.classList.toggle('gliding', deck.isGliding);
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
      playBtn.disabled = cueBtn.disabled = false;
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
        if (library && track) await d.loadStems(await library.readStems(track), track.bpm);
        else await d.load(data);
      },
    });
  });

  playBtn.addEventListener('click', toggle);
  waveform.onSeek = (fraction) => deck.seek(fraction * deck.duration);

  tempoInput.addEventListener('input', () => setTempo(Number(tempoInput.value)));
  tempoInput.addEventListener('dblclick', () => setTempo(0));
  el('tempo-reset').addEventListener('click', () => setTempo(0));
  rangeBtn.addEventListener('click', () => {
    setRange(TEMPO_RANGES[(TEMPO_RANGES.indexOf(range) + 1) % TEMPO_RANGES.length]);
  });
  syncBtn.addEventListener('click', sync);

  // CUE: hay que distinguir pulsar y soltar (por eso no es un simple "click").
  cueBtn.addEventListener('pointerdown', (e) => {
    try {
      cueBtn.setPointerCapture(e.pointerId); // así "soltar" llega aunque muevas el ratón fuera
    } catch {
      // Algunos dispositivos no lo permiten; no pasa nada.
    }
    deck.cueDown();
  });
  cueBtn.addEventListener('pointerup', () => deck.cueUp());
  cueBtn.addEventListener('pointercancel', () => deck.cueUp());

  for (const pad of pads) {
    pad.addEventListener('click', () => deck.toggleStem(pad.dataset.stem as StemName));
  }
  acapellaBtn.addEventListener('click', () => deck.acapella());
  instrumentalBtn.addEventListener('click', () => deck.instrumental());

  // El motor nos avisa cuando algo cambia.
  deck.addEventListener('ended', updatePlayButton);
  deck.addEventListener('transport', updatePlayButton);
  deck.addEventListener('stems', updatePads);
  deck.addEventListener('tempo', showTempo);
  // Si el otro plato carga canción o cambia de tempo, revisamos el SYNC.
  other.addEventListener('loaded', updateSync);
  other.addEventListener('tempo', updateSync);
  deck.addEventListener('loaded', () => {
    badge.hidden = !deck.hasStems;
    updatePads();
    updateBpm();
    updateSync();
  });

  return {
    toggle,
    load,
    cueDown: () => deck.cueDown(),
    cueUp: () => deck.cueUp(),
    render() {
      const position = deck.position;
      timeEl.textContent = formatTime(position);
      remainingEl.textContent = `-${formatTime(Math.max(0, deck.duration - position))}`;
      const d = deck.duration;
      waveform.draw(d ? position / d : 0, d ? deck.cuePoint / d : null);
      cueBtn.classList.toggle('on', deck.isPlaying && Math.abs(deck.position - deck.cuePoint) < 0.05);
    },
  };
}
