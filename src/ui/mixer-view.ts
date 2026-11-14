/**
 * La parte VISUAL del mixer, con ruedas como una mesa de verdad.
 *
 * Cada canal, de arriba abajo:
 *  - GAIN: ganancia de -12 a +12 dB (centro = 0 dB). Para igualar canciones
 *    grabadas más fuertes o más flojas.
 *  - Interruptor EQ / STEMS, y sus 3 ruedas:
 *     · EQ:    Agudos, Medios y Bajos (cortan frecuencias).
 *     · STEMS: Voces, Instru y Beat (suben o quitan partes de la canción).
 *       Solo con canciones preparadas. Van sincronizadas con los pads del
 *       plato: si quitas la voz con el pad, la rueda Voces baja a 0 %.
 *  - FILTRO (izquierda = paso bajo, derecha = paso alto).
 *  - Fader de volumen.
 *
 * Abajo, el master y el crossfader.
 *
 * Truco: en todos los controles, DOBLE CLIC = volver al valor por defecto.
 * Las ruedas se giran arrastrando arriba/abajo o con la rueda del ratón.
 */
import type { Deck, StemGroup } from '../audio/deck';
import {
  EQ_MAX_DB,
  EQ_MIN_DB,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  type Band,
  type Channel,
  type Mixer,
} from '../audio/mixer';
import { createKnob, type Knob } from './knob';
import { isScreenShift, isShift, onShift, registerControl, setLight, setShift } from '../midi/controls';
import { CFX_TYPES, type CfxType } from '../audio/cfx';

/** Mueve un fader de la pantalla desde fuera (controladora) como si lo movieras tú. */
function moveSlider(input: HTMLInputElement, position: number): void {
  const min = Number(input.min);
  const max = Number(input.max);
  input.value = String(min + position * (max - min));
  input.dispatchEvent(new Event('input'));
}

const BANDS: { band: Band; label: string }[] = [
  { band: 'high', label: 'Agudos' },
  { band: 'mid', label: 'Medios' },
  { band: 'low', label: 'Bajos' },
];

const GROUPS: { group: StemGroup; label: string }[] = [
  { group: 'vocal', label: 'Voces' },
  { group: 'instru', label: 'Instru' },
  { group: 'beat', label: 'Beat' },
];

type Mode = 'eq' | 'stems';

/** Lo más que se puede subir un stem con su rueda (1,5 = 150 %, unos +3,5 dB). */
const STEM_MAX = 1.5;

/** "+3 dB", "-6 dB", "0 dB". */
const formatDb = (db: number) => `${db > 0 ? '+' : ''}${Number.isInteger(db) ? db : db.toFixed(1)} dB`;

/**
 * Conecta un deslizador (fader) a una función: cada vez que se mueve, llama a
 * `apply` con su valor. Con doble clic vuelve a `defaultValue`.
 */
function bindSlider(input: HTMLInputElement, defaultValue: number, apply: (value: number) => void): void {
  const update = () => apply(Number(input.value));
  input.addEventListener('input', update);
  input.addEventListener('dblclick', () => {
    input.value = String(defaultValue);
    update();
  });
  update(); // aplica el valor inicial
}

function channelStrip(letter: string, channel: Channel, deck: Deck): HTMLElement {
  const strip = document.createElement('div');
  strip.className = `strip strip-${letter.toLowerCase()}`;
  strip.innerHTML = `
    <span class="strip-letter">${letter}</span>
    <div class="strip-body">
      <div class="strip-knobs">
        <div class="gain-module" data-el="gain"></div>
        <div class="mode" role="group" aria-label="Modo de las ruedas del canal ${letter}">
          <button data-mode="eq" aria-pressed="true">EQ</button>
          <button data-mode="stems" aria-pressed="false" disabled title="Carga una canción preparada">STEMS</button>
        </div>
        <div class="knobs" data-knobs="eq"></div>
        <div class="knobs" data-knobs="stems" hidden></div>
        <div class="filter-knob" data-el="filter"></div>
      </div>
      <input type="range" class="fader" data-el="volume" min="0" max="1" step="0.01" value="0.8"
        aria-label="Volumen del canal ${letter}" />
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string) => strip.querySelector(sel) as T;
  const eqValues: Record<Band, number> = { low: 0, mid: 0, high: 0 };
  let mode: Mode = 'eq';

  /**
   * Aplica el ecualizador según el modo: en STEMS se queda plano (las ruedas
   * controlan los stems). Los stems no se tocan al cambiar de modo: los pads
   * del plato siguen funcionando en los dos modos.
   */
  function apply(): void {
    for (const { band } of BANDS) channel.setEq(band, mode === 'eq' ? eqValues[band] : 0);
  }

  function setMode(next: Mode): void {
    mode = next;
    for (const btn of strip.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    }
    $<HTMLElement>('[data-knobs="eq"]').hidden = mode !== 'eq';
    $<HTMLElement>('[data-knobs="stems"]').hidden = mode !== 'stems';
    apply();
  }

  // GAIN
  const gainKnob = createKnob({
      label: 'Gain',
      ariaLabel: `Ganancia del canal ${letter}`,
      min: GAIN_MIN_DB,
      max: GAIN_MAX_DB,
      value: 0,
      defaultValue: 0,
      step: 0.5,
      bipolar: true,
      format: formatDb,
      onInput: (db) => channel.setGain(db),
  });
  $('[data-el="gain"]').append(gainKnob.el);

  // Ruedas de EQ
  const eqKnobs = {} as Record<Band, Knob>;
  for (const { band, label } of BANDS) {
    const knob = createKnob({
      label,
      ariaLabel: `${label} del canal ${letter}`,
      min: EQ_MIN_DB,
      max: EQ_MAX_DB,
      value: 0,
      defaultValue: 0,
      center: 0, // arriba = 0 dB (izquierda hasta -24, derecha hasta +6)
      step: 0.5,
      bipolar: true,
      format: (db) => (db <= EQ_MIN_DB + 1 ? 'KILL' : formatDb(db)),
      isKilled: (db) => db <= EQ_MIN_DB + 1, // banda quitada del todo: en rojo
      onInput: (db) => {
        eqValues[band] = db;
        apply();
      },
    });
    eqKnobs[band] = knob;
    $('[data-knobs="eq"]').append(knob.el);
  }

  // Ruedas de stems: mueven el volumen del stem en el plato…
  const stemKnobs = {} as Record<StemGroup, Knob>;
  for (const { group, label } of GROUPS) {
    stemKnobs[group] = createKnob({
      label,
      ariaLabel: `${label} del canal ${letter}`,
      // Arriba = 100 % (normal). Izquierda: hasta quitarlo (0 %).
      // Derecha: subirlo por encima de lo normal (hasta 150 %).
      min: 0,
      max: STEM_MAX,
      value: 1,
      defaultValue: 1,
      center: 1,
      step: 0.01,
      bipolar: true,
      format: (v) => `${Math.round(v * 100)}%`,
      isKilled: (v) => v <= 0.02,
      onInput: (v) => deck.setStemGroup(group, v),
    });
    $('[data-knobs="stems"]').append(stemKnobs[group].el);
  }

  // …y cuando el plato cambia (pads, Acapella, Instrumental), las ruedas se
  // colocan solas donde toca. Así pads y ruedas siempre dicen lo mismo.
  const showStemLevels = () => {
    for (const { group } of GROUPS) stemKnobs[group].set(deck.groupLevel(group), true);
  };
  deck.addEventListener('stems', showStemLevels);

  // Ruedita del filtro: centro = apagado. Qué hace la elige el botón FX (cfx.ts).
  //   FILTRO: izquierda = paso bajo (LP), derecha = paso alto (HP).
  //   Los demás: izquierda = versión oscura (◀), derecha = brillante (▶).
  const filterKnob = createKnob({
      label: 'Filtro',
      ariaLabel: `Filtro (efecto) del canal ${letter}`,
      min: -1,
      max: 1,
      value: 0,
      defaultValue: 0,
      step: 0.01,
      bipolar: true,
      format: (v) => {
        if (Math.abs(v) < 0.02) return 'off';
        const pct = `${Math.round(Math.abs(v) * 100)}%`;
        if (cfxState.type === 'filtro') return `${v < 0 ? 'LP' : 'HP'} ${pct}`;
        return v < 0 ? `◀ ${pct}` : `${pct} ▶`;
      },
      onInput: (v) => channel.setFilter(v),
  });
  $('[data-el="filter"]').append(filterKnob.el);
  filterKnobs.push(filterKnob);

  for (const btn of strip.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode as Mode));
  }

  // Al cargar una canción: si trae stems, pasamos a modo STEMS; si no, a EQ.
  deck.addEventListener('loaded', () => {
    $<HTMLButtonElement>('[data-mode="stems"]').disabled = !deck.hasStems;
    setMode(deck.hasStems ? 'stems' : 'eq');
  });

  const volume = $<HTMLInputElement>('[data-el="volume"]');
  bindSlider(volume, 0.8, (v) => channel.setVolume(v));

  // --- Controladora MIDI ---------------------------------------------------------
  // Las 3 ruedas de EQ de la mesa mueven las ruedas que se ven: en modo EQ,
  // Agudos/Medios/Bajos; en modo STEMS, Voces/Instru/Beat (como en la pantalla).
  const eqOrStem = (band: Band, group: StemGroup) => ({
    value: (p: number) => (mode === 'eq' ? eqKnobs[band] : stemKnobs[group]).setPosition(p),
  });
  registerControl(`${letter}.gain`, { value: (p) => gainKnob.setPosition(p) });
  registerControl(`${letter}.eqHigh`, eqOrStem('high', 'vocal'));
  registerControl(`${letter}.eqMid`, eqOrStem('mid', 'instru'));
  registerControl(`${letter}.eqLow`, eqOrStem('low', 'beat'));
  registerControl(`${letter}.filter`, { value: (p) => filterKnob.setPosition(p) });
  registerControl(`${letter}.volume`, { value: (p) => moveSlider(volume, p) });
  return strip;
}

export function createMixerView(root: HTMLElement, mixer: Mixer, deckA: Deck, deckB: Deck): void {
  root.classList.add('mixer');
  root.setAttribute('aria-label', 'Mixer');
  root.innerHTML = `
    <div class="strips"></div>
    <div class="cfx-panel" role="group" aria-label="Efecto de la ruedita del filtro">
      <button class="cfx-shift" data-el="shift" aria-pressed="false"
        title="SHIFT: mientras está encendido, los botones hacen su otra función (también vale la tecla Mayúsculas)">SHIFT</button>
      ${[0, 1, 2, 3].map((i) => `<button class="cfx-btn" data-cfx-slot="${i}" aria-pressed="false"></button>`).join('')}
    </div>
    <label class="master">
      <span>Master</span>
      <input type="range" data-el="master" min="0" max="1" step="0.01" value="0.9" aria-label="Volumen master" />
    </label>
    <div class="xfader">
      <span>A</span>
      <input type="range" data-el="xfader" min="0" max="1" step="0.01" value="0.5" aria-label="Crossfader" />
      <span>B</span>
    </div>
  `;

  const strips = root.querySelector('.strips')!;
  strips.append(channelStrip('A', mixer.a, deckA), channelStrip('B', mixer.b, deckB));

  bindSlider(root.querySelector<HTMLInputElement>('[data-el="master"]')!, 0.9, (v) => mixer.setMasterVolume(v));
  const xfader = root.querySelector<HTMLInputElement>('[data-el="xfader"]')!;
  bindSlider(xfader, 0.5, (v) => mixer.setCrossfader(v));
  registerControl('xfader', { value: (p) => moveSlider(xfader, p) });

  // --- Botones FX: qué hace la ruedita del filtro ------------------------------------
  //  4 botones = 4 efectos. Con SHIFT, los mismos 4 botones son los otros 4 efectos
  //  (igual que los 4 botones de FX de la Hercules Inpulse 500).
  const shiftBtn = root.querySelector<HTMLButtonElement>('[data-el="shift"]')!;
  const slotBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-cfx-slot]')];

  function selectCfx(type: CfxType): void {
    cfxState.type = type;
    mixer.setCfxType(type);
    const label = CFX_TYPES.find((t) => t.id === type)!.label;
    for (const knob of filterKnobs) knob.setLabel(label);
    showCfx();
  }

  /** Pinta los 4 botones (del banco que toque según SHIFT) y las luces de la mesa. */
  function showCfx(): void {
    const bank = isShift() ? 1 : 0;
    slotBtns.forEach((btn, i) => {
      const fx = CFX_TYPES[bank * 4 + i];
      btn.textContent = fx.label;
      btn.setAttribute('aria-pressed', String(fx.id === cfxState.type));
      setLight(`cfx.${i + 1}`, fx.id === cfxState.type);
    });
    shiftBtn.setAttribute('aria-pressed', String(isScreenShift()));
    shiftBtn.classList.toggle('held', isShift() && !isScreenShift()); // pulsado en la mesa o el teclado
    root.querySelector('.cfx-panel')!.classList.toggle('shifted', isShift());
    // SMART CFX de la FLX4 encendido cuando hay un efecto distinto del filtro normal.
    setLight('cfx.smart', cfxState.type !== 'filtro');
  }

  /** Pasa al efecto siguiente (o al anterior con SHIFT), en círculo. */
  function cycleCfx(): void {
    const i = CFX_TYPES.findIndex((t) => t.id === cfxState.type);
    const step = isShift() ? -1 : 1;
    selectCfx(CFX_TYPES[(i + step + CFX_TYPES.length) % CFX_TYPES.length].id);
  }

  /** Botón n (0-3) del banco que toque. */
  const pressSlot = (n: number) => selectCfx(CFX_TYPES[(isShift() ? 4 : 0) + n].id);

  slotBtns.forEach((btn, i) => btn.addEventListener('click', () => pressSlot(i)));
  shiftBtn.addEventListener('click', () => setShift('pantalla', !isScreenShift()));
  onShift(showCfx);

  // Controladora: SMART CFX (FLX4) = siguiente / SHIFT + SMART CFX = anterior;
  // FX 1-4 (Inpulse 500) = elegir directamente (con SHIFT, los otros 4).
  registerControl('cfx.next', { press: (down) => down && cycleCfx() });
  for (let n = 0; n < 4; n++) registerControl(`cfx.${n + 1}`, { press: (down) => down && pressSlot(n) });

  selectCfx('filtro');
}

/** Qué efecto tiene la ruedita del filtro ahora (común a los dos canales). */
const cfxState: { type: CfxType } = { type: 'filtro' };
/** Las ruedas del filtro de los dos canales (para cambiarles el nombre). */
const filterKnobs: Knob[] = [];
