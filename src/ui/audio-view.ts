/**
 * Indicador "AUDIO" de la barra de arriba y su panel con el REGISTRO.
 *
 *   ● verde = todo bien · ● ámbar = hubo un aviso (y se arregló solo)
 *   ● rojo  = el audio está parado: pulsa "Reactivar audio"
 *
 * Al pulsarlo se abre un panel con todo lo que ha pasado (con la hora).
 * Si vuelve a cortarse el sonido, mira aquí y pásale a Claude lo que pone.
 */
import { audioHealth } from '../audio/health';

const LABELS = { ok: 'Audio OK', aviso: 'Audio: aviso', parado: 'Audio PARADO' };

export function createAudioView(button: HTMLButtonElement, panel: HTMLElement, reactivate: () => void): void {
  panel.classList.add('audio-panel');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="audio-panel-bar">
      <strong>Registro de audio</strong>
      <span class="muted-text">si deja de sonar, aquí se apunta qué ha pasado</span>
      <button class="small" data-el="reactivate">Reactivar audio</button>
      <button class="small" data-el="clear">Borrar registro</button>
    </div>
    <ol class="audio-log" data-el="log"></ol>
  `;
  const log = panel.querySelector<HTMLOListElement>('[data-el="log"]')!;

  function render(): void {
    button.dataset.status = audioHealth.status;
    button.textContent = LABELS[audioHealth.status];
    log.replaceChildren(
      ...(audioHealth.entries.length
        ? audioHealth.entries.map((e) => {
            const li = document.createElement('li');
            li.textContent = `${e.time}  ${e.message}`;
            return li;
          })
        : [Object.assign(document.createElement('li'), { textContent: 'Nada que contar: todo ha ido bien.' })]),
    );
  }

  audioHealth.addEventListener('change', render);
  button.addEventListener('click', () => (panel.hidden = !panel.hidden));
  panel.querySelector('[data-el="reactivate"]')!.addEventListener('click', () => {
    reactivate();
    audioHealth.log('Audio reactivado a mano', 'ok');
  });
  panel.querySelector('[data-el="clear"]')!.addEventListener('click', () => audioHealth.clear());
  render();
}
