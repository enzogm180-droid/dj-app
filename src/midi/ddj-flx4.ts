/**
 * MAPA de la Pioneer DDJ-FLX4: qué mensaje MIDI manda cada botón, fader o
 * rueda, y qué control de la app mueve (los nombres de src/midi/controls.ts).
 *
 * Un mensaje MIDI son 3 números (en hexadecimal, por eso llevan "0x"):
 *
 *     0x90   0x0B   0x7F
 *     ────   ────   ────
 *     tipo   cuál   valor
 *
 *  - TIPO: 0x9_ = botón (nota), 0xB_ = fader/rueda (control). El último
 *    dígito es el CANAL: la FLX4 usa el 0 para el plato izquierdo, el 1 para
 *    el derecho, el 6 para lo del centro (crossfader, filtros, navegador) y
 *    el 7 y el 9 para los pads de cada plato.
 *  - CUÁL: el número de ese botón o fader.
 *  - VALOR: botones 0x7F = pulsado, 0x00 = soltado; faders de 0 a 127.
 *
 * Los faders y ruedas de la FLX4 son de alta precisión ("14 bits"): mandan
 * dos mensajes, el grueso (MSB) y el fino (LSB, el mismo número + 0x20).
 *
 * ⚠ Estos números salen de la documentación pública de MIDI de Pioneer y de
 * otros programas libres. Si alguno no responde, el MONITOR MIDI de la app
 * (botón "MIDI" arriba) enseña qué mensaje llega al tocarlo, y basta con
 * corregir aquí su número.
 */

export type BindingKind =
  | 'button' // botón: pulsar / soltar
  | 'fader' // fader o rueda con tope (0 a 1)
  | 'relative' // rueda sin tope: 0x01 = un clic a la derecha, 0x7F = uno a la izquierda
  | 'jog'; // plato: 0x40 = quieto; más = adelante, menos = atrás

export interface MidiBinding {
  /** Tipo + canal (p. ej. 0x90 = botón del canal 0). */
  status: number;
  /** Qué botón o fader. */
  data1: number;
  kind: BindingKind;
  /** El control de la app (ver controls.ts). */
  control: string;
  /** Fader al revés (arriba = 0). */
  invert?: boolean;
}

/** Una luz de la controladora: el mensaje que la enciende (valor 0x7F) o apaga (0x00). */
export interface MidiLight {
  status: number;
  data1: number;
}

export interface ControllerMap {
  name: string;
  /** Cómo reconocer la controladora por el nombre que da Windows. */
  match: RegExp;
  bindings: MidiBinding[];
  lights: Record<string, MidiLight[]>;
}

const NOTE = 0x90;
const CC = 0xb0;

/** Lo de cada plato: igual en los dos, cambia el canal (0 = A, 1 = B; pads 7 y 9). */
function deck(letter: 'A' | 'B', ch: number, padCh: number): { bindings: MidiBinding[]; lights: Record<string, MidiLight[]> } {
  const btn = (data1: number, control: string): MidiBinding => ({ status: NOTE + ch, data1, kind: 'button', control: `${letter}.${control}` });
  const fader = (data1: number, control: string, invert = false): MidiBinding => ({
    status: CC + ch,
    data1,
    kind: 'fader',
    control: `${letter}.${control}`,
    invert,
  });

  const bindings: MidiBinding[] = [
    // Transporte
    btn(0x0b, 'play'),
    btn(0x0c, 'cue'),
    btn(0x58, 'sync'),
    // Tempo (fader largo). En Pioneer, ARRIBA = más lento (−) y ABAJO = más rápido (+).
    // ⚠ A comprobar con la mesa: si sale al revés, poner `true` (invertir).
    fader(0x00, 'tempo', false),
    // Loops: IN, OUT, RELOOP/EXIT (quita o vuelve a poner el loop) y CUE/LOOP CALL ◀ ▶ (mitad / doble)
    btn(0x10, 'loopIn'),
    btn(0x11, 'loopOut'),
    btn(0x4d, 'loop'),
    btn(0x51, 'loopHalf'),
    btn(0x53, 'loopDouble'),
    // Modo de los pads: HOT CUE → nuestra página HOT CUES; PAD FX 1 → nuestra página STEMS
    btn(0x1b, 'padPage.hotcues'),
    btn(0x1e, 'padPage.stems'),
    // Plato (jog): tocar la parte de arriba, girar tocándola, girar por el borde
    btn(0x36, 'jogTouch'),
    { status: CC + ch, data1: 0x22, kind: 'jog', control: `${letter}.jogTop` },
    { status: CC + ch, data1: 0x21, kind: 'jog', control: `${letter}.jogSide` },
    // Mixer (cada canal va en el canal MIDI de su plato)
    fader(0x04, 'gain'),
    fader(0x07, 'eqHigh'),
    fader(0x0b, 'eqMid'),
    fader(0x0f, 'eqLow'),
    fader(0x13, 'volume'),
    // Filtro (rueda CFX): va por el canal 6, uno por plato
    { status: CC + 6, data1: letter === 'A' ? 0x17 : 0x18, kind: 'fader', control: `${letter}.filter` },
    // Cargar la canción elegida en la lista (botones LOAD, canal 6)
    { status: NOTE + 6, data1: letter === 'A' ? 0x46 : 0x47, kind: 'button', control: `${letter}.load` },
  ];

  // Pads: 8 por plato. Cada modo de la FLX4 usa otra tanda de números
  // (hot cue 0x00-0x07, pad fx 0x10-0x17, beat jump 0x20-0x27…); para nosotros
  // da igual el modo: el pad nº (número % 8) hace lo que diga la página de la app.
  for (let note = 0; note < 0x80; note++) {
    bindings.push({ status: NOTE + padCh, data1: note, kind: 'button', control: `${letter}.pad${(note % 8) + 1}` });
  }

  const light = (data1: number, status = NOTE + ch): MidiLight => ({ status, data1 });
  const lights: Record<string, MidiLight[]> = {
    [`${letter}.play`]: [light(0x0b)],
    [`${letter}.cue`]: [light(0x0c)],
    [`${letter}.sync`]: [light(0x58)],
    [`${letter}.loop`]: [light(0x10), light(0x11)],
  };
  // Luz de cada pad, en los dos modos que usamos (HOT CUE y PAD FX 1).
  for (let i = 0; i < 8; i++) lights[`${letter}.pad${i + 1}`] = [light(i, NOTE + padCh), light(0x10 + i, NOTE + padCh)];
  return { bindings, lights };
}

const a = deck('A', 0, 7);
const b = deck('B', 1, 9);

export const DDJ_FLX4: ControllerMap = {
  name: 'Pioneer DDJ-FLX4',
  match: /FLX4/i,
  bindings: [
    ...a.bindings,
    ...b.bindings,
    // Centro de la mesa (canal 6)
    { status: CC + 6, data1: 0x1f, kind: 'fader', control: 'xfader' },
    { status: CC + 6, data1: 0x40, kind: 'relative', control: 'browse' }, // rueda del navegador
  ],
  lights: { ...a.lights, ...b.lights },
};

/** Todas las controladoras que conocemos (de momento, una). */
export const CONTROLLER_MAPS: ControllerMap[] = [DDJ_FLX4];
