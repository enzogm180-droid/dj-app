/**
 * La parte VISUAL de un plato: título, BPM, tiempos, onda, CUE/PLAY/SYNC,
 * tempo, los pads de stems y los loops.
 *
 * Es una función que sirve para cualquier plato: la llamamos una vez para
 * el A y otra para el B, cada una con su propio Deck (motor de audio).
 */
import type { Deck, StemName } from '../audio/deck';
import type { Library } from '../library/library';
import type { FxRack } from '../audio/fx';
import { registerControl, setLight } from '../midi/controls';
import { createFxView } from './fx-view';
import { Jog } from './jog';
import { HOT_CUE_COLORS } from './stem-draw';
import { Waveform } from './waveform';

/**
 * Rangos del fader de tempo (en %). El botón "±8%" va pasando de uno a otro.
 * ±8 % es lo típico y da más precisión; los grandes sirven para juntar
 * canciones con BPM muy distintos.
 */
const TEMPO_RANGES = [8, 16, 33, 50];

/** Velocidad del SYNC: cuánto tempo cambia por segundo (en %). */
const SYNC_SPEED = 2;

/** Tamaños de loop, en golpes. */
const LOOP_SIZES = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];

/** "4", "1/2"… para enseñar un tamaño de loop. */
function formatBeats(beats: number): string {
  beats = Math.round(beats * 100) / 100; // 3.9999 → 4
  if (beats >= 1) return Number.isInteger(beats) ? String(beats) : beats.toFixed(1);
  const inverse = Math.round(1 / beats);
  return Math.abs(1 / inverse - beats) < 0.01 ? `1/${inverse}` : beats.toFixed(2);
}

/**
 * Ajustes compartidos por los dos platos.
 * `assist`: asistencia de golpe. Al dar PLAY con la otra canción sonando, se
 * arranca justo en su golpe; y SYNC, además del BPM, cuadra los golpes.
 */
export const deckSettings = { assist: true };

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
  /** Los efectos de este plato. */
  fx: FxRack,
  getLibrary: () => Library | null,
): DeckView {
  root.classList.add('deck', `deck-${letter.toLowerCase()}`);
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

    <div class="deck-body">
    <div class="deck-main">
    <div class="fx" data-el="fx"></div>

    <div class="pad-pages">
      <div class="pad-tabs" role="group" aria-label="Qué hacen los pads del plato ${letter}">
        <button data-pad-page="stems" aria-pressed="true">STEMS</button>
        <button data-pad-page="hotcues" aria-pressed="false">HOT CUES</button>
      </div>

      <div class="pads" data-page="stems" role="group" aria-label="Stems del plato ${letter}">
        ${PADS.map(({ stem, label }) => `<button class="pad" data-stem="${stem}" disabled aria-pressed="false">${label}</button>`).join('')}
        <button class="pad mode-pad" data-el="acapella" disabled aria-pressed="false">Acapella</button>
        <button class="pad mode-pad" data-el="instrumental" disabled aria-pressed="false">Instrumental</button>
      </div>

      <div class="pads" data-page="hotcues" role="group" aria-label="Hot cues del plato ${letter}" hidden>
        ${HOT_CUE_COLORS.map(
          (color, i) =>
            `<button class="pad hotcue" data-hotcue="${i}" style="--hc: ${color}" disabled
              title="Vacío: guarda aquí el punto · Lleno: salta a él">${i + 1}</button>`,
        ).join('')}
        ${HOT_CUE_COLORS.map(
          (color, i) =>
            `<button class="pad hotcue-delete" data-hotcue-delete="${i}" style="--hc: ${color}" disabled
              aria-label="Borrar hot cue ${i + 1}" title="Borra el hot cue ${i + 1}">✕ ${i + 1}</button>`,
        ).join('')}
      </div>
    </div>

    <div class="loops">
      <div class="loop-tabs" role="group" aria-label="Tipo de loop del plato ${letter}">
        <button data-loop-mode="snap" aria-pressed="true" title="Loop ajustado: empieza y acaba justo en un golpe">L.AJUST</button>
        <button data-loop-mode="free" aria-pressed="false" title="Loop personalizado: empieza justo cuando pulsas, haya golpe o no">L.PERS</button>
      </div>
      <div class="loop-row">
        <button data-el="loop-in" disabled title="Marca el inicio del loop">IN</button>
        <button data-el="loop-out" disabled title="Marca el final y empieza a repetirse">OUT</button>
        <button class="small" data-el="loop-half" disabled aria-label="Loop a la mitad">‹</button>
        <button class="loop-btn" data-el="loop" disabled>LOOP <span data-el="loop-size">4</span></button>
        <button class="small" data-el="loop-double" disabled aria-label="Loop al doble">›</button>
      </div>
    </div>
    </div>

    <div class="jog-col">
      <canvas class="jog" data-el="jog" aria-label="Plato ${letter}: arrastra en círculo para mover o empujar la canción"></canvas>
      <div class="transport">
        <button class="cue" data-el="cue" disabled title="Mantén pulsado para escuchar; al soltar vuelve al punto CUE">CUE</button>
        <button class="play" data-el="play" disabled aria-label="Play">▶</button>
        <button class="sync" data-el="sync" disabled title="Iguala poco a poco el BPM al del otro plato">SYNC</button>
      </div>
    </div>

    <div class="tempo" role="group" aria-label="Tempo del plato ${letter}">
      <output data-el="tempo-value">0.0 %</output>
      <input type="range" data-el="tempo" min="${-TEMPO_RANGES[0]}" max="${TEMPO_RANGES[0]}" step="0.05" value="0"
        aria-label="Tempo del plato ${letter}" />
      <button class="small" data-el="tempo-range" title="Rango del fader de tempo">±${TEMPO_RANGES[0]}%</button>
      <button class="small" data-el="tempo-reset" title="Tempo a 0 %">0%</button>
    </div>
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
  createFxView(el('fx'), fx, letter);
  const jog = new Jog(el<HTMLCanvasElement>('jog'), deck, letter);

  function updatePlayButton(): void {
    playBtn.textContent = deck.isPlaying ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', deck.isPlaying ? 'Pausa' : 'Play');
    playBtn.classList.toggle('on', deck.isPlaying);
    setLight(`${letter}.play`, deck.isPlaying);
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
    updatePadLights();
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
    // Si el tempo se sale del rango del fader (p. ej. tras un SYNC), lo ampliamos.
    if (Math.abs(pct) > range + 0.01) {
      const fits = TEMPO_RANGES.find((r) => r >= Math.abs(pct));
      if (fits) return setRange(fits);
    }
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
    if (change < 0.01) {
      // El BPM ya está igualado: solo falta (si sonando las dos) cuadrar los golpes.
      if (deckSettings.assist) deck.alignPhaseTo(other);
      return;
    }
    const seconds = Math.min(8, Math.max(1, change / SYNC_SPEED));
    deck.glideTempo(finalRate, seconds * 1000);
    // Con la asistencia, al terminar de igualar el BPM cuadramos también los golpes.
    if (deckSettings.assist) {
      setTimeout(() => {
        if (!deck.isGliding) deck.alignPhaseTo(other);
      }, seconds * 1000 + 100);
    }
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
    setLight(`${letter}.sync`, !deck.isGliding && inSync());
  }

  async function toggle(): Promise<void> {
    if (!deck.loaded) return;
    // Con la asistencia y la otra canción sonando, PLAY arranca justo en su golpe.
    if (!deck.isPlaying && deckSettings.assist && other.isPlaying) await deck.playAlignedTo(other);
    else await deck.toggle();
    updatePlayButton();
  }

  // --- Loops ---------------------------------------------------------------------
  const loopInBtn = el<HTMLButtonElement>('loop-in');
  const loopOutBtn = el<HTMLButtonElement>('loop-out');
  const loopBtn = el<HTMLButtonElement>('loop');
  const loopSizeEl = el('loop-size');
  const loopHalfBtn = el<HTMLButtonElement>('loop-half');
  const loopDoubleBtn = el<HTMLButtonElement>('loop-double');
  const loopButtons = [loopInBtn, loopOutBtn, loopBtn, loopHalfBtn, loopDoubleBtn];
  /** true = L.AJUST (al golpe), false = L.PERS (libre). */
  let snap = true;
  let sizeIndex = LOOP_SIZES.indexOf(4);

  function updateLoop(): void {
    const loop = deck.loop;
    loopBtn.classList.toggle('on', loop !== null);
    setLight(`${letter}.loop`, loop !== null);
    loopInBtn.classList.toggle('on', deck.loopIn !== null);
    // Con un loop activo enseñamos su tamaño real; si no, el elegido.
    loopSizeEl.textContent = formatBeats(loop ? (loop.end - loop.start) / deck.beatLength : LOOP_SIZES[sizeIndex]);
    for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-loop-mode]')) {
      btn.setAttribute('aria-pressed', String((btn.dataset.loopMode === 'snap') === snap));
    }
  }

  function changeSize(step: number): void {
    sizeIndex = Math.min(LOOP_SIZES.length - 1, Math.max(0, sizeIndex + step));
    deck.resizeLoop(LOOP_SIZES[sizeIndex]); // si hay un loop sonando, cambia ya
    updateLoop();
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-loop-mode]')) {
    btn.addEventListener('click', () => {
      snap = btn.dataset.loopMode === 'snap';
      updateLoop();
    });
  }
  loopBtn.addEventListener('click', () => {
    if (deck.loop) deck.exitLoop();
    else deck.autoLoop(LOOP_SIZES[sizeIndex], snap);
  });
  loopInBtn.addEventListener('click', () => deck.markLoopIn(snap));
  loopOutBtn.addEventListener('click', () => deck.markLoopOut(snap));
  loopHalfBtn.addEventListener('click', () => changeSize(-1));
  loopDoubleBtn.addEventListener('click', () => changeSize(1));
  deck.addEventListener('loop', updateLoop);

  // --- Páginas de pads: STEMS o HOT CUES ---------------------------------------
  let padPage: 'stems' | 'hotcues' = 'stems';

  function showPadPage(page: 'stems' | 'hotcues'): void {
    padPage = page;
    updatePadLights();
    for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-pad-page]')) {
      tab.setAttribute('aria-pressed', String(tab.dataset.padPage === page));
    }
    for (const grid of root.querySelectorAll<HTMLElement>('[data-page]')) {
      grid.hidden = grid.dataset.page !== page;
    }
  }
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-pad-page]')) {
    tab.addEventListener('click', () => showPadPage(tab.dataset.padPage as 'stems' | 'hotcues'));
  }

  // --- Hot cues ------------------------------------------------------------------
  //  Fila de arriba:  vacío → guarda el punto (ajustado al golpe con L.AJUST);
  //                   lleno → salta a ese punto sin perder el ritmo.
  //  Fila de abajo:   ✕ borra el hot cue que tiene encima.
  const hotCueBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-hotcue]')];
  const deleteBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-hotcue-delete]')];

  function updateHotCues(): void {
    hotCueBtns.forEach((btn, i) => {
      const t = deck.hotCues[i];
      btn.disabled = !deck.loaded;
      btn.classList.toggle('set', t !== null);
      btn.textContent = t === null ? String(i + 1) : `${i + 1} · ${formatTime(t).replace(/\.\d$/, '')}`;
      btn.setAttribute('aria-label', t === null ? `Hot cue ${i + 1} vacío` : `Hot cue ${i + 1} en ${formatTime(t)}`);
      deleteBtns[i].disabled = t === null; // solo se puede borrar si hay algo
    });
    updatePadLights();
  }

  // --- Controladora MIDI -----------------------------------------------------------
  // La mesa tiene 8 pads por plato. Hacen lo mismo que los pads de la pantalla
  // según la página que esté elegida:
  //   STEMS:     1-4 = Voces, Melodía, Bajo, Batería · 5 = Acapella · 6 = Instrumental
  //   HOT CUES:  1-4 = hot cues (guardar / saltar)  · 5-8 = borrar el de encima
  function padButton(n: number): HTMLButtonElement | null {
    if (padPage === 'hotcues') return n < 4 ? hotCueBtns[n] : (deleteBtns[n - 4] ?? null);
    return [...pads, acapellaBtn, instrumentalBtn][n] ?? null;
  }

  /** Luces de los pads de la mesa: encendido = stem sonando / hot cue guardado. */
  function updatePadLights(): void {
    for (let n = 0; n < 8; n++) {
      let on = false;
      if (padPage === 'hotcues') on = n < 4 && deck.hotCues[n] !== null;
      else if (n < 4) on = deck.hasStems && deck.isStemOn(pads[n].dataset.stem as StemName);
      else if (n < 6) on = (n === 4 ? acapellaBtn : instrumentalBtn).classList.contains('active');
      setLight(`${letter}.pad${n + 1}`, on);
    }
  }

  /** Un botón de la mesa = un clic en el botón de la pantalla (si está activo). */
  const clickOnPress = (btn: () => HTMLButtonElement | null) => ({
    press: (down: boolean) => {
      const b = btn();
      if (down && b && !b.disabled) b.click();
    },
  });
  registerControl(`${letter}.play`, { press: (down) => down && void toggle() });
  registerControl(`${letter}.cue`, {
    press: (down) => {
      if (!deck.loaded) return;
      if (down) void deck.cueDown();
      else deck.cueUp();
    },
  });
  registerControl(`${letter}.sync`, clickOnPress(() => syncBtn));
  // Fader de tempo: de 0 (un extremo) a 1 (el otro); el centro = 0 %.
  // Con una pequeña "zona muerta" en el centro: así el fader en medio da 0 % exacto.
  registerControl(`${letter}.tempo`, {
    value: (p) => setTempo(Math.abs(p - 0.5) < 0.004 ? 0 : (p * 2 - 1) * range),
  });
  registerControl(`${letter}.loopIn`, clickOnPress(() => loopInBtn));
  registerControl(`${letter}.loopOut`, clickOnPress(() => loopOutBtn));
  registerControl(`${letter}.loop`, clickOnPress(() => loopBtn));
  registerControl(`${letter}.loopHalf`, clickOnPress(() => loopHalfBtn));
  registerControl(`${letter}.loopDouble`, clickOnPress(() => loopDoubleBtn));
  registerControl(`${letter}.padPage.hotcues`, { press: (down) => down && showPadPage('hotcues') });
  registerControl(`${letter}.padPage.stems`, { press: (down) => down && showPadPage('stems') });
  for (let n = 0; n < 8; n++) registerControl(`${letter}.pad${n + 1}`, clickOnPress(() => padButton(n)));
  registerControl(`${letter}.jogTouch`, { press: (down) => jog.midiTouch(down) });
  registerControl(`${letter}.jogTop`, { turn: (ticks) => jog.midiTurn(ticks) });
  registerControl(`${letter}.jogSide`, { turn: (ticks) => jog.midiTurn(ticks) });

  hotCueBtns.forEach((btn, i) => btn.addEventListener('click', () => deck.hotCue(i, snap)));
  deleteBtns.forEach((btn, i) => btn.addEventListener('click', () => deck.deleteHotCue(i)));
  deck.addEventListener('hotcues', updateHotCues);
  deck.addEventListener('loaded', updateHotCues);

  async function load(request: LoadRequest): Promise<void> {
    titleEl.textContent = `Cargando ${request.title}…`;
    artistEl.textContent = '';
    playBtn.disabled = true;
    try {
      await request.load(deck);
      waveform.setVisual(deck.visual);
      titleEl.textContent = request.title;
      artistEl.textContent = request.artist;
      playBtn.disabled = cueBtn.disabled = false;
      for (const btn of loopButtons) btn.disabled = false;
      updateLoop();
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
        if (library && track) {
          await d.loadStems(await library.readStems(track), {
            id: track.stems!.folder,
            bpm: track.bpm,
            beat: track.beat,
            ...(await library.readLyrics(track)), // letra (de internet o de Whisper)
          });
        } else {
          await d.load(data, { id: `archivo:${file.name}:${file.size}` });
        }
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
      waveform.draw(d ? position / d : 0, d ? deck.cuePoint / d : null, deck.loop, deck.hotCues);
      jog.draw();
      const cueOn = deck.isPlaying && Math.abs(deck.position - deck.cuePoint) < 0.05;
      cueBtn.classList.toggle('on', cueOn);
      setLight(`${letter}.cue`, cueOn);
    },
  };
}
