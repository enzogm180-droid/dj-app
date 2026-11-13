/**
 * Relleno de color de los faders: hasta dónde pintar.
 *
 * El navegador no sabe pintar un fader "relleno hasta la tapa", así que en
 * cada fotograma le decimos a cada fader (input range) dónde está su tapa, con
 * la variable CSS --p (de 0 = mínimo a 1 = máximo). style.css usa ese número
 * para pintar el relleno (sección "Faders a medida").
 *
 * Lo hacemos en cada fotograma (y no solo al moverlo con el ratón) porque
 * muchos faders se mueven solos: el tempo con SYNC, el volumen desde la
 * controladora MIDI… Así el relleno nunca se queda atrás. Son una docena de
 * faders: no cuesta nada.
 *
 * El TEMPO es especial: rellena desde el centro (0 %) hasta la tapa, hacia
 * arriba o hacia abajo. Para eso le damos el inicio (--a) y el fin (--b).
 */
const last = new WeakMap<HTMLInputElement, number>();

export function updateFaderFills(root: ParentNode = document): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const p = max > min ? (Number(input.value) - min) / (max - min) : 0;
    if (last.get(input) === p) continue; // no ha cambiado: no tocamos nada
    last.set(input, p);
    input.style.setProperty('--p', p.toFixed(4));
    if (input.closest('.tempo')) {
      // Del centro (0,5) a la tapa, sea hacia arriba o hacia abajo.
      input.style.setProperty('--a', Math.min(0.5, p).toFixed(4));
      input.style.setProperty('--b', Math.max(0.5, p).toFixed(4));
    }
  }
}
