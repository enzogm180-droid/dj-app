/**
 * Botón "MIDI" de la barra de arriba y el MONITOR MIDI.
 *
 *  - Primer clic: pide permiso al navegador y conecta la controladora.
 *  - Después, cada clic abre o cierra el monitor: una lista con los últimos
 *    mensajes que ha mandado la mesa y a qué control de la app han ido.
 *    Si tocas algo y sale "sin asignar", ese botón no está en el mapa
 *    (src/midi/ddj-flx4.ts) o tiene otro número: el monitor te dice cuál.
 */
import { connectMidi, midiSupported, onMidiMessage, onMidiStatus } from '../midi/midi';

const MAX_LINES = 14;

export function createMidiView(button: HTMLButtonElement, panel: HTMLElement): void {
  panel.classList.add('midi-panel');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="midi-status" data-el="status"></div>
    <p class="midi-help">Toca cualquier botón, fader o rueda de la mesa: aquí sale el mensaje y a qué control ha ido.</p>
    <ol class="midi-log" data-el="log"></ol>
  `;
  const statusEl = panel.querySelector<HTMLElement>('[data-el="status"]')!;
  const log = panel.querySelector<HTMLOListElement>('[data-el="log"]')!;
  let connected = false;

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
