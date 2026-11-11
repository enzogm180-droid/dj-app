/**
 * La parte VISUAL del mixer: ecualizador y volumen de cada canal,
 * crossfader y volumen master.
 *
 * Truco: en todos los controles, DOBLE CLIC = volver al valor por defecto.
 */
import { EQ_MAX_DB, EQ_MIN_DB, type Band, type Channel, type Mixer } from '../audio/mixer';

const BANDS: { band: Band; label: string }[] = [
  { band: 'high', label: 'Agudos' },
  { band: 'mid', label: 'Medios' },
  { band: 'low', label: 'Bajos' },
];

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

function channelStrip(letter: string, channel: Channel): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.innerHTML = `
    <span class="strip-letter">${letter}</span>
    ${BANDS.map(
      ({ band, label }) => `
      <label class="eq">
        <span>${label} <output data-band-value="${band}">0</output></span>
        <input type="range" data-band="${band}" min="${EQ_MIN_DB}" max="${EQ_MAX_DB}" step="0.5" value="0"
          aria-label="${label} del canal ${letter}" />
      </label>`,
    ).join('')}
    <input type="range" class="fader" data-el="volume" min="0" max="1" step="0.01" value="0.8"
      aria-label="Volumen del canal ${letter}" />
  `;

  for (const { band } of BANDS) {
    const input = strip.querySelector<HTMLInputElement>(`[data-band="${band}"]`)!;
    const output = strip.querySelector<HTMLOutputElement>(`[data-band-value="${band}"]`)!;
    bindSlider(input, 0, (db) => {
      channel.setEq(band, db);
      output.textContent = db > 0 ? `+${db}` : String(db);
      // Si la banda está casi quitada del todo, la marcamos ("kill").
      input.classList.toggle('killed', db <= EQ_MIN_DB + 1);
    });
  }

  bindSlider(strip.querySelector<HTMLInputElement>('[data-el="volume"]')!, 0.8, (v) => channel.setVolume(v));
  return strip;
}

export function createMixerView(root: HTMLElement, mixer: Mixer): void {
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
  strips.append(channelStrip('A', mixer.a), channelStrip('B', mixer.b));

  bindSlider(root.querySelector<HTMLInputElement>('[data-el="master"]')!, 0.9, (v) => mixer.setMasterVolume(v));
  bindSlider(root.querySelector<HTMLInputElement>('[data-el="xfader"]')!, 0.5, (v) => mixer.setCrossfader(v));
}
