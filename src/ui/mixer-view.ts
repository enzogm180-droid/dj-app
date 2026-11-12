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
  strip.className = 'strip';
  strip.innerHTML = `
    <span class="strip-letter">${letter}</span>
    <div class="gain-module" data-el="gain"></div>
    <div class="mode" role="group" aria-label="Modo de las ruedas del canal ${letter}">
      <button data-mode="eq" aria-pressed="true">EQ</button>
      <button data-mode="stems" aria-pressed="false" disabled title="Carga una canción preparada">STEMS</button>
    </div>
    <div class="knobs" data-knobs="eq"></div>
    <div class="knobs" data-knobs="stems" hidden></div>
    <div class="filter-knob" data-el="filter"></div>
    <input type="range" class="fader" data-el="volume" min="0" max="1" step="0.01" value="0.8"
      aria-label="Volumen del canal ${letter}" />
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
  $('[data-el="gain"]').append(
    createKnob({
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
    }).el,
  );

  // Ruedas de EQ
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

  // Filtro: centro = apagado, izquierda = paso bajo, derecha = paso alto.
  $('[data-el="filter"]').append(
    createKnob({
      label: 'Filtro',
      ariaLabel: `Filtro del canal ${letter}`,
      min: -1,
      max: 1,
      value: 0,
      defaultValue: 0,
      step: 0.01,
      bipolar: true,
      format: (v) => (Math.abs(v) < 0.02 ? 'off' : `${v < 0 ? 'LP' : 'HP'} ${Math.round(Math.abs(v) * 100)}%`),
      onInput: (v) => channel.setFilter(v),
    }).el,
  );

  for (const btn of strip.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode as Mode));
  }

  // Al cargar una canción: si trae stems, pasamos a modo STEMS; si no, a EQ.
  deck.addEventListener('loaded', () => {
    $<HTMLButtonElement>('[data-mode="stems"]').disabled = !deck.hasStems;
    setMode(deck.hasStems ? 'stems' : 'eq');
  });

  bindSlider($<HTMLInputElement>('[data-el="volume"]'), 0.8, (v) => channel.setVolume(v));
  return strip;
}

export function createMixerView(root: HTMLElement, mixer: Mixer, deckA: Deck, deckB: Deck): void {
  root.classList.add('mixer');
  root.setAttribute('aria-label', 'Mixer');
  root.innerHTML = `
    <div class="strips"></div>
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
  bindSlider(root.querySelector<HTMLInputElement>('[data-el="xfader"]')!, 0.5, (v) => mixer.setCrossfader(v));
}
