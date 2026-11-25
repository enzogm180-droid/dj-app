/**
 * MAPA de la Hercules DJControl Inpulse 500: qué mensaje MIDI manda cada
 * botón, fader o rueda, y qué control de la app mueve (los nombres de
 * src/midi/controls.ts). Funciona igual que el mapa de la FLX4
 * (src/midi/ddj-flx4.ts): allí está explicado qué son los 3 números.
 *
 * CANALES de la Inpulse 500 (el último dígito del primer número):
 *   - 0 → lo del centro (crossfader, navegador, botones FX)
 *   - 1 → plato izquierdo (A)        · 4 → plato A con SHIFT pulsado
 *   - 2 → plato derecho (B)          · 5 → plato B con SHIFT pulsado
 *   - 6 → pads del plato A           · 7 → pads del plato B
 * Es decir: con SHIFT pulsado, la mesa manda el MISMO número pero 3 canales
 * más allá (0x91 → 0x94). Así sabemos cuándo es "SHIFT + algo".
 *
 * ⚠ DE DÓNDE SALEN ESTOS NÚMEROS: del mapa público y libre de otro programa
 * de DJ (Mixxx), NO de probar con la mesa. Todavía NO se han comprobado con
 * una Inpulse 500 de verdad. Los marcados con "⚠ sin confirmar" son los más
 * dudosos. Para comprobarlos: botón "MIDI" de arriba → monitor MIDI → tocar
 * el botón o la rueda → mirar qué mensaje llega y a qué control va. Si no
 * coincide, basta con corregir aquí su número.
 */
import type { ControllerMap, MidiBinding, MidiLight } from './ddj-flx4';

const NOTE = 0x90;
const CC = 0xb0;

/** Lo de cada plato: igual en los dos, cambia el canal (1 = A, 2 = B; pads 6 y 7). */
function deck(letter: 'A' | 'B', ch: number, padCh: number): { bindings: MidiBinding[]; lights: Record<string, MidiLight[]> } {
  const shiftCh = ch + 3; // el mismo botón con SHIFT pulsado llega por este canal
  const btn = (data1: number, control: string, channel = ch): MidiBinding => ({
    status: NOTE + channel,
    data1,
    kind: 'button',
    control: `${letter}.${control}`,
  });
  const fader = (data1: number, control: string, invert = false): MidiBinding => ({
    status: CC + ch,
    data1,
    kind: 'fader',
    control: `${letter}.${control}`,
    invert,
  });

  const bindings: MidiBinding[] = [
    // Transporte
    btn(0x07, 'play'),
    btn(0x06, 'cue'),
    btn(0x05, 'sync'),
    // SHIFT (hay uno en cada plato; cualquiera vale)
    { status: NOTE + ch, data1: 0x04, kind: 'button', control: 'shift' },
    // Con SHIFT pulsado llegan por el canal "+3":
    btn(0x05, 'syncOff', shiftCh), // SHIFT + SYNC → volver al BPM original
    btn(0x06, 'cueStart', shiftCh), // SHIFT + CUE  → volver al principio
    // Botón de AURICULARES de cada canal (pre-escucha en los cascos)
    btn(0x0c, 'headCue'),
    // LOAD de cada plato: carga la canción elegida en la lista
    btn(0x0d, 'load'),
    // Fader de tempo. ⚠ sin confirmar el SENTIDO: si al subirlo la canción va
    // más rápida cuando debería ir más lenta (o al revés), poner `true` (invertir).
    fader(0x08, 'tempo', false),

    // --- LOOP ---
    // IN y OUT: marcan el principio y el final del loop.
    btn(0x09, 'loopIn'),
    btn(0x0a, 'loopOut'),
    // La RUEDECITA de loop:
    //  - girarla a la derecha → loop el doble de largo; a la izquierda → la mitad
    { status: CC + ch, data1: 0x0e, kind: 'relative', control: `${letter}.loopSize` },
    //  - pulsarla → pone un loop (del tamaño elegido) o lo quita si ya hay uno
    btn(0x2c, 'loop'),

    // --- Plato (jog) ---
    // Girarlo. Esta mesa manda "1 = un clic adelante, 127 = uno atrás" (relativo).
    // ⚠ sin confirmar: la sensibilidad (cuántos clics da una vuelta) y el número
    // del sensor de TOCAR la parte de arriba (no viene claro en la documentación:
    // por eso no está puesto; el monitor MIDI dirá cuál es).
    { status: CC + ch, data1: 0x0a, kind: 'relative', control: `${letter}.jogSide` },

    // --- Mixer (cada canal va en el canal MIDI de su plato) ---
    fader(0x00, 'volume'),
    fader(0x05, 'gain'),
    fader(0x04, 'eqHigh'),
    fader(0x03, 'eqMid'),
    fader(0x02, 'eqLow'),
    // Rueda de FX/FILTRO de cada plato: hace lo mismo que la ruedita CFX de la
    // app (el efecto elegido con FX1-FX4: Filtro, Eco, Espacio o Gate).
    // ⚠ sin confirmar que la rueda del centro mande este número.
    fader(0x01, 'filter'),
  ];

  // Pads: 8 por plato. Cada modo de la Inpulse usa otra tanda de números
  // (hot cue 0x00-0x07, loop 0x10-0x17, … beat jump 0x70-0x77; con SHIFT,
  // los 8 siguientes). Para nosotros da igual: el pad nº (número % 8) hace lo
  // que diga la página de pads elegida en la app.
  for (let note = 0; note < 0x80; note++) {
    bindings.push({ status: NOTE + padCh, data1: note, kind: 'button', control: `${letter}.pad${(note % 8) + 1}` });
  }
  // ⚠ Los 8 botones de MODO de los pads (HOT CUE, ROLL, SLICER, SAMPLER…)
  // mandan los números 0x0F a 0x16, pero la documentación no deja claro cuál
  // es cuál, así que NO están puestos: se asignan con "Aprender" en el monitor
  // MIDI (Plato A/B: pads STEMS, HOT CUES, BEAT JUMP o SAMPLER).

  // Luces. ⚠ sin confirmar: en las Hercules la luz de un botón suele
  // encenderse mandándole su mismo mensaje. Si alguna no se enciende, no pasa nada.
  const light = (data1: number, status = NOTE + ch): MidiLight => ({ status, data1 });
  const lights: Record<string, MidiLight[]> = {
    [`${letter}.play`]: [light(0x07)],
    [`${letter}.cue`]: [light(0x06)],
    [`${letter}.sync`]: [light(0x05)],
    [`${letter}.headCue`]: [light(0x0c)],
    [`${letter}.loop`]: [light(0x09), light(0x0a)],
  };
  // Luz de cada pad, en todas las tandas de números (así se ve en cualquier modo).
  for (let i = 0; i < 8; i++) {
    lights[`${letter}.pad${i + 1}`] = [0x00, 0x10, 0x20, 0x30, 0x50, 0x60, 0x70].map((base) => light(base + i, NOTE + padCh));
  }
  return { bindings, lights };
}

const a = deck('A', 1, 6);
const b = deck('B', 2, 7);

export const INPULSE_500: ControllerMap = {
  name: 'Hercules DJControl Inpulse 500',
  // Windows la suele llamar "DJControl Inpulse 500".
  match: /Inpulse\s*500/i,
  bindings: [
    ...a.bindings,
    ...b.bindings,
    // Centro de la mesa (canal 0)
    { status: CC + 0, data1: 0x00, kind: 'fader', control: 'xfader' }, // crossfader
    { status: CC + 0, data1: 0x01, kind: 'relative', control: 'browse' }, // rueda del navegador
    // Los 4 botones FX1, FX2, FX3 y FX4 del centro eligen el efecto de las
    // ruedas de FX: FX1 = Filtro, FX2 = Eco, FX3 = Espacio, FX4 = Gate.
    // ⚠ sin confirmar (lo más dudoso de todo el mapa). Si no responden, se
    // asignan con "Aprender" en el monitor MIDI ("FX 1: Filtro"…).
    { status: NOTE + 0, data1: 0x14, kind: 'button', control: 'cfx.1' },
    { status: NOTE + 0, data1: 0x15, kind: 'button', control: 'cfx.2' },
    { status: NOTE + 0, data1: 0x16, kind: 'button', control: 'cfx.3' },
    { status: NOTE + 0, data1: 0x17, kind: 'button', control: 'cfx.4' },
    // ⚠ Las ruedas de MASTER y de AURICULARES no vienen en la documentación:
    // falta saber su número (el monitor MIDI lo dirá al girarlas).
  ],
  lights: {
    ...a.lights,
    ...b.lights,
    // Luz del botón FX del efecto elegido (⚠ sin confirmar).
    'cfx.1': [{ status: NOTE + 0, data1: 0x14 }],
    'cfx.2': [{ status: NOTE + 0, data1: 0x15 }],
    'cfx.3': [{ status: NOTE + 0, data1: 0x16 }],
    'cfx.4': [{ status: NOTE + 0, data1: 0x17 }],
  },
};
