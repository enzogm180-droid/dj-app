/**
 * Análisis visual de una canción, para dibujar sus ondas:
 *
 *  - PICOS: para cada trocito de tiempo (1/150 s), cuánto suena cada capa.
 *    Con stems hay 4 capas (voces, melodía, bajo, batería), así podemos
 *    pintar cada una de un color y ver cuándo entra cada cosa.
 *
 *  - TRAMOS DE BAJO: en qué partes de la canción suena el bajo y en cuáles
 *    no (los "breaks"). Sirve para saber cuándo meter la otra canción:
 *    normalmente se entra cuando el bajo "rompe" o se cambia de bajo a bajo.
 *
 * Se calcula una vez al cargar la canción (tarda unas décimas de segundo).
 */
import type { StemName } from './deck';

/** Trocitos por segundo de los picos. */
export const PEAKS_PER_SECOND = 150;

export type LayerName = StemName | 'main';

export interface TrackVisual {
  duration: number;
  /** Picos (de 0 a 1) de cada capa, un valor por trocito. */
  peaks: Partial<Record<LayerName, Float32Array>>;
  /** El mayor pico de la suma de todas las capas (para escalar la onda). */
  maxTotal: number;
  /** Tramos (en segundos) en los que suena el bajo. Vacío si no hay stems. */
  bass: [number, number][];
}

export function analyze(layers: { name: LayerName; buffer: AudioBuffer }[]): TrackVisual {
  const duration = Math.max(0, ...layers.map((l) => l.buffer.duration));
  const count = Math.ceil(duration * PEAKS_PER_SECOND);
  const peaks: TrackVisual['peaks'] = {};

  for (const { name, buffer } of layers) {
    const out = new Float32Array(count);
    const step = buffer.sampleRate / PEAKS_PER_SECOND;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * step);
      const end = Math.min(buffer.length, Math.floor((i + 1) * step));
      let max = 0;
      for (const data of channels) {
        for (let s = start; s < end; s++) {
          const v = Math.abs(data[s]);
          if (v > max) max = v;
        }
      }
      out[i] = max;
    }
    peaks[name] = out;
  }

  let maxTotal = 0.0001;
  for (let i = 0; i < count; i++) {
    let total = 0;
    for (const p of Object.values(peaks)) total += p![i];
    if (total > maxTotal) maxTotal = total;
  }

  const bassLayer = layers.find((l) => l.name === 'bass');
  return { duration, peaks, maxTotal, bass: bassLayer ? bassSections(bassLayer.buffer) : [] };
}

/**
 * Busca los tramos con bajo:
 *  1. Medimos la energía del bajo cada 0,1 s y la suavizamos (media de 1 s),
 *     para que no cuente cada nota suelta sino "si hay bajo o no".
 *  2. Comparamos con lo fuerte que suele sonar el bajo en ESTA canción: se
 *     enciende al pasar del 35 % y se apaga al bajar del 20 % (dos umbrales
 *     distintos para que no parpadee en el límite).
 *  3. Juntamos huecos de menos de 1 s y quitamos tramos de menos de 2 s.
 */
function bassSections(buffer: AudioBuffer): [number, number][] {
  const hop = Math.round(buffer.sampleRate / 10); // 0,1 s
  const frames = Math.floor(buffer.length / hop);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (const data of channels) {
      for (let s = f * hop; s < (f + 1) * hop; s++) sum += data[s] * data[s];
    }
    energy[f] = Math.sqrt(sum / (hop * channels.length));
  }

  // Media móvil de 1 s (10 trocitos).
  const smooth = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += energy[f];
    if (f >= 10) acc -= energy[f - 10];
    smooth[f] = acc / Math.min(f + 1, 10);
  }

  // "Lo fuerte que suele sonar": el percentil 90 (ignora picos sueltos).
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const reference = sorted[Math.floor(sorted.length * 0.9)] || 0;
  if (reference < 1e-4) return [];
  const on = reference * 0.35;
  const off = reference * 0.2;

  let sections: [number, number][] = [];
  let start: number | null = null;
  for (let f = 0; f < frames; f++) {
    if (start === null && smooth[f] > on) start = f;
    else if (start !== null && smooth[f] < off) {
      sections.push([start / 10, f / 10]);
      start = null;
    }
  }
  if (start !== null) sections.push([start / 10, frames / 10]);

  // Juntar huecos cortos y quitar tramos cortos.
  const merged: [number, number][] = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 1) last[1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  sections = merged.filter(([a, b]) => b - a >= 2);
  return sections;
}
