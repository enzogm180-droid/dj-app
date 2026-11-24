/**
 * Botón "MIDI" de la barra de arriba y el MONITOR MIDI.
 *
 *  - Primer clic: pide permiso al navegador y conecta la controladora.
 *  - Después, cada clic abre o cierra el monitor: una lista con los últimos
 *    mensajes que ha mandado la mesa y a qué control de la app han ido.
 *    Si tocas algo y sale "sin asignar", ese botón no está en el mapa
 *    (src/midi/ddj-flx4.ts) o tiene otro número: el monitor te dice cuál.
 */
import {
  cancelLearn,
  connectMidi,
  forgetLearned,
  learn,
  learnedBindings,
  midiSupported,
  onMidiMessage,
  onMidiStatus,
} from '../midi/midi';

const MAX_LINES = 14;

/** Funciones que se pueden asignar a un botón de la mesa con "Aprender". */
const LEARNABLE: { control: string; label: string }[] = [
  { control: 'cfx.next', label: 'Botón FX (siguiente efecto; con SHIFT, el anterior) — SMART CFX' },
  { control: 'cfx.1', label: 'FX 1: Filtro' },
  { control: 'cfx.2', label: 'FX 2: Eco' },
  { control: 'cfx.3', label: 'FX 3: Espacio' },
  { control: 'cfx.4', label: 'FX 4: Gate' },
  { control: 'shift', label: 'SHIFT' },
  { control: 'A.headCue', label: 'Canal A: CUE de auriculares (pre-escucha)' },
  { control: 'B.headCue', label: 'Canal B: CUE de auriculares (pre-escucha)' },
  { control: 'A.syncOff', label: 'Plato A: desincronizar (volver al BPM original)' },
  { control: 'B.syncOff', label: 'Plato B: desincronizar (volver al BPM original)' },
  { control: 'A.cueStart', label: 'Plato A: volver al principio (SHIFT + CUE)' },
  { control: 'B.cueStart', label: 'Plato B: volver al principio (SHIFT + CUE)' },
];

export function createMidiView(button: HTMLButtonElement, panel: HTMLElement): void {
  panel.classList.add('midi-panel');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="midi-status" data-el="status"></div>
    <p class="midi-help">Toca cualquier botón, fader o rueda de la mesa: aquí sale el mensaje y a qué control ha ido.</p>
    <div class="midi-learn">
      <span>Asignar un botón de la mesa a:</span>
      <select data-el="learn-control" aria-label="Función a asignar">
        ${LEARNABLE.map(({ control, label }) => `<option value="${control}">${label}</option>`).join('')}
      </select>
      <button class="small" data-el="learn">Aprender</button>
      <button class="small" data-el="forget" title="Borra los botones aprendidos y vuelve al mapa de fábrica">Olvidar aprendidos</button>
      <span class="midi-learn-msg" data-el="learn-msg"></span>
    </div>
    <ol class="midi-log" data-el="log"></ol>
  `;
  const statusEl = panel.querySelector<HTMLElement>('[data-el="status"]')!;
  const log = panel.querySelector<HTMLOListElement>('[data-el="log"]')!;
  const learnSelect = panel.querySelector<HTMLSelectElement>('[data-el="learn-control"]')!;
  const learnBtn = panel.querySelector<HTMLButtonElement>('[data-el="learn"]')!;
  const learnMsg = panel.querySelector<HTMLElement>('[data-el="learn-msg"]')!;
  let connected = false;

  const showLearned = () => {
    const n = learnedBindings().length;
    learnMsg.textContent = n ? `${n} botón(es) aprendido(s).` : '';
  };
  showLearned();

  learnBtn.addEventListener('click', async () => {
    if (learnBtn.classList.contains('on')) {
      cancelLearn(); // segundo clic = cancelar
      return;
    }
    learnBtn.classList.add('on');
    learnBtn.textContent = 'Cancelar';
    learnMsg.textContent = 'Ahora pulsa el botón de la mesa…';
    const hex = await learn(learnSelect.value);
    learnBtn.classList.remove('on');
    learnBtn.textContent = 'Aprender';
    if (hex) learnMsg.textContent = `Hecho: ${hex} → ${learnSelect.selectedOptions[0].text}`;
    else showLearned();
  });
  panel.querySelector('[data-el="forget"]')!.addEventListener('click', () => {
    forgetLearned();
    showLearned();
  });

  if (!midiSupported()) {
    button.disabled = true;
    button.title = 'Este navegador no tiene MIDI. Usa Chrome o Edge.';
  }

  onMidiStatus((s) => {
    button.textContent = s.device ? `MIDI: ${s.device}` : 'MIDI';
    button.classList.toggle('on', s.device !== null);
    statusEl.textContent = s.message;
  });

  onMidiMessage((entry) => {
    const li = document.createElement('li');
    li.className = entry.control ? '' : 'unmapped';
    li.textContent = `${entry.hex}  →  ${entry.control ?? 'sin asignar'}`;
    log.prepend(li);
    while (log.children.length > MAX_LINES) log.lastElementChild!.remove();
  });

  button.addEventListener('click', async () => {
    if (!connected) {
      connected = true;
      panel.hidden = false;
      await connectMidi();
      return;
    }
    panel.hidden = !panel.hidden;
  });
}
