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
