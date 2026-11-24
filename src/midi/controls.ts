/**
 * El "tablón de mandos" de la app.
 *
 * Cada parte de la pantalla (platos, mixer, biblioteca) apunta aquí sus
 * controles con un NOMBRE, p. ej. "A.play" o "B.volume", y qué hacer con él.
 * La controladora MIDI (src/midi/midi.ts) no sabe nada de botones de la
 * pantalla: solo dice "han pulsado A.play" y el tablón llama a quien toca.
 *
 *    controladora ──► midi.ts ──► mapa (ddj-flx4.ts) ──► "A.play" ──► plato A
 *
 * Así, para otra controladora solo hace falta otro mapa: los nombres son los
 * mismos para todas.
 *
 * Y al revés, para las LUCES: el plato dice "A.play encendido" y, si hay una
 * controladora con esa luz, midi.ts la enciende.
 */

/** Qué sabe hacer un control. Cada uno usa lo que le corresponde. */
export interface ControlHandler {
  /** Botón: `down` = true al pulsar, false al soltar. */
  press?(down: boolean): void;
  /** Fader o rueda con tope: posición de 0 (abajo/izquierda) a 1 (arriba/derecha). */
  value?(position: number): void;
  /** Rueda sin tope (jog, selector): cuántos "clics" ha girado (+ derecha, − izquierda). */
  turn?(delta: number): void;
}

const handlers = new Map<string, ControlHandler>();

/** Apunta un control en el tablón (lo llaman los platos, el mixer…). */
export function registerControl(id: string, handler: ControlHandler): void {
  handlers.set(id, handler);
}

/** ¿Existe un control con ese nombre? (para el monitor MIDI). */
export function hasControl(id: string): boolean {
  return handlers.has(id);
}

export function pressControl(id: string, down: boolean): void {
  handlers.get(id)?.press?.(down);
}

export function setControlValue(id: string, position: number): void {
  handlers.get(id)?.value?.(Math.min(1, Math.max(0, position)));
}

export function turnControl(id: string, delta: number): void {
  handlers.get(id)?.turn?.(delta);
}

// --- Luces ---------------------------------------------------------------------

type LightListener = (id: string, on: boolean) => void;
const lightListeners = new Set<LightListener>();
const lightState = new Map<string, boolean>();

/** La app avisa de que una luz cambia (p. ej. "A.play" se enciende al sonar). */
export function setLight(id: string, on: boolean): void {
  if (lightState.get(id) === on) return; // sin cambios: no molestamos a la controladora
  lightState.set(id, on);
  for (const listener of lightListeners) listener(id, on);
}

/** midi.ts escucha las luces para encenderlas en la controladora. */
export function onLight(listener: LightListener): void {
  lightListeners.add(listener);
}

/** Todas las luces como están ahora (al conectar la controladora, para ponerla al día). */
export function currentLights(): Map<string, boolean> {
  return new Map(lightState);
}

// --- SHIFT -----------------------------------------------------------------------
//
// SHIFT es un "comodín": mientras está pulsado, algunos botones hacen OTRA cosa
// (p. ej. SHIFT + SYNC = volver al BPM original; SHIFT + FX = el otro banco).
//
// Se puede activar de tres formas, y basta con una:
//   - "mesa":     el botón SHIFT de la controladora (mientras lo mantienes)
//   - "teclado":  la tecla Mayúsculas (mientras la mantienes)
//   - "pantalla": el botón SHIFT del mixer (se queda pulsado hasta volver a pulsarlo,
//                 porque con el ratón no puedes mantenerlo y a la vez pulsar otra cosa)

type ShiftSource = 'mesa' | 'teclado' | 'pantalla';
const shiftSources = new Set<ShiftSource>();
const shiftListeners = new Set<(on: boolean) => void>();

/** ¿Está SHIFT activo ahora? */
export function isShift(): boolean {
  return shiftSources.size > 0;
}

export function setShift(source: ShiftSource, on: boolean): void {
  const before = isShift();
  if (on) shiftSources.add(source);
  else shiftSources.delete(source);
  if (before && !isShift()) shiftReleasedAt = performance.now();
  if (isShift() !== before) for (const listener of shiftListeners) listener(isShift());
}

/** Cuándo se soltó SHIFT por última vez (para "SHIFT y seguidamente…"). */
let shiftReleasedAt = -Infinity;
/** Cuánto tiempo después de soltar SHIFT sigue contando (1,5 s). */
const SHIFT_GRACE_MS = 1500;

/**
 * ¿SHIFT está pulsado, o se acaba de soltar hace un momento?
 * Sirve para los que pulsan SHIFT, lo sueltan y SEGUIDAMENTE pulsan el otro
 * botón (en vez de mantenerlo). Solo vale una vez: después ya no cuenta.
 */
export function consumeShift(): boolean {
  if (isShift()) return true;
  const recent = performance.now() - shiftReleasedAt < SHIFT_GRACE_MS;
  shiftReleasedAt = -Infinity;
  return recent;
}

/** ¿Está el SHIFT de la pantalla enganchado? (para pintar el botón) */
export function isScreenShift(): boolean {
  return shiftSources.has('pantalla');
}

/** Avisa cada vez que SHIFT se activa o desactiva. */
export function onShift(listener: (on: boolean) => void): void {
  shiftListeners.add(listener);
}

// El botón SHIFT de la controladora (hay uno por plato: cualquiera vale).
registerControl('shift', { press: (down) => setShift('mesa', down) });
