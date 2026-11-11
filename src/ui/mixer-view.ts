/**
 * La parte VISUAL del mixer: ruedas de cada canal, volumen, crossfader y master.
 *
 * Cada canal tiene un interruptor EQ / STEMS:
 *  - EQ:    las 3 ruedas son Agudos, Medios y Bajos (cortan frecuencias).
 *  - STEMS: las 3 ruedas son Voces, Instru y Beat (suben o quitan partes de la
 *           canción). Solo se puede usar si la canción está preparada.
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
    <input type="range" class="fader" data-el="volume" min="0" max="1" step="0.01" value="0.8"
      aria-label="Volumen del canal ${letter}" />
  `;

  const $ = <T extends HTMLElement>(sel: string) => strip.querySelector(sel) as T;
  const eqValues: Record<Band, number> = { low: 0, mid: 0, high: 0 };
  const stemValues: Record<StemGroup, number> = { vocal: 1, instru: 1, beat: 1 };
  let mode: Mode = 'eq';

  /** Aplica al sonido lo que toca según el modo (el otro modo queda "neutro"). */
  function apply(): void {
    for (const { band } of BANDS) channel.setEq(band, mode === 'eq' ? eqValues[band] : 0);
    for (const { group } of GROUPS) deck.setStemGroup(group, mode === 'stems' ? stemValues[group] : 1);
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

  for (const { group } of GROUPS) {
    const input = $<HTMLInputElement>(`[data-group="${group}"]`);
    const output = $<HTMLOutputElement>(`[data-group-value="${group}"]`);
    bindSlider(input, 1, (level) => {
      stemValues[group] = level;
      output.textContent = `${Math.round(level * 100)}%`;
      input.classList.toggle('killed', level <= 0.02);
      apply();
    });
  }

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
