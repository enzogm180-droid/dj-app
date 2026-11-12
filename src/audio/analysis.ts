/**
 * Análisis visual de una canción, para dibujar sus ondas:
 *
 *  - PICOS: para cada trocito de tiempo (1/150 s), cuánto suena cada capa.
 *    Con stems hay 4 capas (voces, melodía, bajo, batería), así podemos
 *    pintar cada una de un color y ver cuándo entra cada cosa.
 *
 *  - BOOMS: cada golpe grave (bombo y bajo). Se dibuja un rectangulito por
 *    cada uno debajo de la onda: donde no hay rectangulitos, el bajo "rompe"
 *    (un break); donde vuelven, entra el bajo. Sirve para saber cuándo meter
 *    la otra canción y para cuadrar un boom con otro.
 *
 * Se calcula una vez al cargar la canción (tarda unas décimas de segundo).
 */
import type { StemName } from './deck';

/** Trocitos por segundo de los picos. */
export const PEAKS_PER_SECOND = 150;

export type LayerName = StemName | 'main';

/** Un boom: en qué segundo suena (t) y cómo de fuerte, de 0 a 1 (s). */
export interface Boom {
  t: number;
  s: number;
}

export interface TrackVisual {
  duration: number;
  /** Picos (de 0 a 1) de cada capa, un valor por trocito. */
  peaks: Partial<Record<LayerName, Float32Array>>;
  /** El mayor pico de la suma de todas las capas (para escalar la onda). */
  maxTotal: number;
  /** Cada golpe grave de la canción. */
  booms: Boom[];
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

  // Los booms salen de la batería + el bajo (bombo y bajos de 808). Sin stems,
  // de la canción entera (funciona, pero se cuelan más cosas).
  const low = layers.filter((l) => l.name === 'drums' || l.name === 'bass');
  const boomSource = (low.length ? low : layers).map((l) => l.buffer);
  return { duration, peaks, maxTotal, booms: findBooms(boomSource) };
}

/**
 * Busca cada golpe grave:
 *  1. Nos quedamos solo con los graves (filtro paso bajo a ~120 Hz).
 *  2. Medimos su energía cada 5 ms y vemos cuándo SUBE de golpe.
 *  3. Cada subida que sea un pico (la mayor en ±60 ms) y suficientemente
 *     fuerte para ESTA canción es un boom. Entre dos booms, mínimo 90 ms.
 */
function findBooms(buffers: AudioBuffer[]): Boom[] {
  const sampleRate = buffers[0].sampleRate;
  const length = Math.min(...buffers.map((b) => b.length));
  const channels = buffers.flatMap((b) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
  const hop = Math.round(sampleRate / 200); // 5 ms
  const frames = Math.floor(length / hop);

  // 1 y 2: energía de los graves por trocito.
  const alpha = 1 - Math.exp((-2 * Math.PI * 120) / sampleRate);
  let lp1 = 0;
  let lp2 = 0; // dos filtros seguidos: corta mejor los agudos
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      lp1 += alpha * (v - lp1);
      lp2 += alpha * (lp1 - lp2);
      e += lp2 * lp2;
    }
    energy[f] = Math.log1p(1000 * (e / hop));
  }

  // Subida de energía respecto a hace 15 ms (más estable que contra el trocito anterior).
  const rise = new Float32Array(frames);
  for (let f = 3; f < frames; f++) rise[f] = Math.max(0, energy[f] - energy[f - 3]);

  // 3: umbral relativo a esta canción (percentil 98 de las subidas).
  const sorted = Array.from(rise).filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const reference = sorted[Math.floor(sorted.length * 0.98)];
  const threshold = reference * 0.3;
  const window = 12; // ±60 ms
  const minGap = 18; // 90 ms

  const booms: Boom[] = [];
  let last = -Infinity;
  for (let f = window; f < frames - window; f++) {
    const v = rise[f];
    if (v < threshold || f - last < minGap) continue;
    let isPeak = true;
    for (let k = f - window; k <= f + window; k++) {
      if (rise[k] > v) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    // El golpe empieza un poco antes del pico de subida: retrocedemos hasta que la subida casi desaparece.
    let start = f;
    while (start > f - 6 && rise[start - 1] > v * 0.15) start--;
    booms.push({ t: (start * hop) / sampleRate, s: Math.min(1, v / reference) });
    last = f;
  }
  return booms;
}
