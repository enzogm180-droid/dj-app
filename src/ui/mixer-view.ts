/**
 * La parte VISUAL del mixer: ruedas de cada canal, volumen, crossfader y master.
 *
 * Cada canal tiene un interruptor EQ / STEMS:
 *  - EQ:    las 3 ruedas son Agudos, Medios y Bajos (cortan frecuencias).
 *  - STEMS: las 3 ruedas son Voces, Instru y Beat (suben o quitan partes de la
 *           canción). Solo se puede usar si la canción está preparada.
 *           Van sincronizadas con los pads del plato: si quitas la voz con
 *           el pad, la rueda Voces baja a 0 %; si subes la rueda, vuelve.
 *
 * Debajo, la rueda de FILTRO (izquierda = paso bajo, derecha = paso alto).
 *
 * Truco: en todos los controles, DOBLE CLIC = volver al valor por defecto.
 */
import type { Deck, StemGroup } from '../audio/deck';
import { EQ_MAX_DB, EQ_MIN_DB, type Band, type Channel, type Mixer } from '../audio/mixer';

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

/**
 * Conecta un deslizador a una función: cada vez que se mueve, llama a
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

function knob(kind: string, key: string, label: string, letter: string, min: number, max: number, step: number, value: number): string {
  return `
    <label class="eq">
      <span>${label} <output data-${kind}-value="${key}"></output></span>
      <input type="range" data-${kind}="${key}" min="${min}" max="${max}" step="${step}" value="${value}"
        aria-label="${label} del canal ${letter}" />
    </label>`;
}

function channelStrip(letter: string, channel: Channel, deck: Deck): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.innerHTML = `
    <span class="strip-letter">${letter}</span>
    <div class="mode" role="group" aria-label="Modo de las ruedas del canal ${letter}">
      <button data-mode="eq" aria-pressed="true">EQ</button>
      <button data-mode="stems" aria-pressed="false" disabled title="Carga una canción preparada">STEMS</button>
    </div>
    <div class="knobs" data-knobs="eq">
      ${BANDS.map(({ band, label }) => knob('band', band, label, letter, EQ_MIN_DB, EQ_MAX_DB, 0.5, 0)).join('')}
    </div>
    <div class="knobs" data-knobs="stems" hidden>
      ${GROUPS.map(({ group, label }) => knob('group', group, label, letter, 0, 1, 0.01, 1)).join('')}
    </div>
    <div class="filter-knob">
      ${knob('filter', 'filter', 'Filtro', letter, -1, 1, 0.01, 0)}
    </div>
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

  for (const { band } of BANDS) {
    const input = $<HTMLInputElement>(`[data-band="${band}"]`);
    const output = $<HTMLOutputElement>(`[data-band-value="${band}"]`);
    bindSlider(input, 0, (db) => {
      eqValues[band] = db;
      output.textContent = db > 0 ? `+${db}` : String(db);
      // Si la banda está casi quitada del todo, la marcamos ("kill").
      input.classList.toggle('killed', db <= EQ_MIN_DB + 1);
      apply();
    });
  }

  // Ruedas de stems: mueven el volumen del stem en el plato…
  for (const { group } of GROUPS) {
    bindSlider($<HTMLInputElement>(`[data-group="${group}"]`), 1, (level) => deck.setStemGroup(group, level));
  }

  // …y cuando el plato cambia (pads, Acapella, Instrumental), las ruedas se
  // colocan solas donde toca. Así pads y ruedas siempre dicen lo mismo.
  function showStemLevels(): void {
    for (const { group } of GROUPS) {
      const input = $<HTMLInputElement>(`[data-group="${group}"]`);
      const level = deck.groupLevel(group);
      input.value = String(level);
      $<HTMLOutputElement>(`[data-group-value="${group}"]`).textContent = `${Math.round(level * 100)}%`;
      input.classList.toggle('killed', level <= 0.02);
    }
  }
  deck.addEventListener('stems', showStemLevels);
  showStemLevels();

  // Filtro: centro = apagado, izquierda = paso bajo, derecha = paso alto.
  const filterOutput = $<HTMLOutputElement>('[data-filter-value="filter"]');
  bindSlider($<HTMLInputElement>('[data-filter="filter"]'), 0, (v) => {
    channel.setFilter(v);
    const pct = Math.round(Math.abs(v) * 100);
    filterOutput.textContent = Math.abs(v) < 0.02 ? 'off' : `${v < 0 ? 'LP' : 'HP'} ${pct}%`;
  });

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
