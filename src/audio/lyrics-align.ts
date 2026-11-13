/**
 * Letra de internet → palabras en su momento
 * =========================================
 *
 * La letra que descarga el buscador (tools/preparador/buscar_letras.py) viene
 * bien escrita y con el segundo en que EMPIEZA cada frase:
 *
 *     12,9 s  "No van a poder, baby"
 *     16,4 s  "Apagar lo que tenemos"
 *
 * Pero la onda dibuja la letra PALABRA A PALABRA. Para colocar cada palabra
 * usamos el stem de VOCES (sus picos, que ya calculamos para dibujar la onda):
 *
 *   1. Marcamos cada trocito de la canción como "suena voz" o "silencio".
 *   2. Comprobamos si toda la letra va un pelín adelantada o retrasada respecto
 *      a TU archivo (pasa a veces) y la corregimos.
 *   3. Dentro de cada frase repartimos sus palabras SOLO sobre los tramos donde
 *      suena la voz (saltando respiros y pausas), y a cada palabra le damos un
 *      tiempo proporcional a sus sílabas ("apagar" dura más que "no").
 *
 * No sabe QUÉ palabra suena en cada instante (eso necesitaría una IA), pero
 * así las frases caen en su sitio y las palabras van sobre la voz.
 */
import { PEAKS_PER_SECOND } from './analysis';
import type { LyricWord } from './deck';

/** Una frase de la letra de internet: cuándo empieza (t) y qué dice. */
export interface LyricLine {
  t: number;
  texto: string;
}

const RATE = PEAKS_PER_SECOND; // trocitos por segundo de los picos (150)
const SECONDS_PER_SYLLABLE = 0.2; // a ojo: lo que se tarda en cantar una sílaba
const MAX_OFFSET = 1.5; // corrección máxima de toda la letra (s)
const LINE_END_SILENCE = 0.6; // un silencio así de largo cierra la frase (s)

/** Convierte las frases en palabras con su inicio (t) y su fin (e). */
export function alignLines(lines: LyricLine[], vocals: Float32Array | undefined, duration: number): LyricWord[] {
  const sorted = lines.filter((l) => Number.isFinite(l.t)).sort((a, b) => a.t - b.t);
  const voiced = vocals?.length ? voicedMask(vocals) : null;
  const offset = voiced ? bestOffset(sorted, voiced) : 0;

  const out: LyricWord[] = [];
  sorted.forEach((line, i) => {
    const words = line.texto.split(/\s+/).filter(Boolean);
    if (!words.length) return; // frase vacía: en LRC marca una pausa
    const start = line.t + offset;
    const next = i + 1 < sorted.length ? sorted[i + 1].t + offset : duration;
    out.push(...(voiced ? placeOnVoice(words, start, next, voiced) : null) ?? spreadEvenly(words, start, next));
  });
  return out;
}

// --- 1. ¿Dónde suena la voz? ------------------------------------------------------

/** 1 = en este trocito suena voz, 0 = silencio. */
function voicedMask(vocals: Float32Array): Uint8Array {
  // Suavizamos un poco (≈ 50 ms) para no cortar la voz entre sílaba y sílaba.
  const half = 3;
  const env = new Float32Array(vocals.length);
  for (let i = 0; i < vocals.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(vocals.length - 1, i + half); k++) {
      sum += vocals[k];
      n++;
    }
    env[i] = sum / n;
  }
  // El umbral depende de ESTA canción: un 12 % de lo fuerte que suele sonar su voz.
  const loud = Array.from(env).filter((v) => v > 0.001).sort((a, b) => a - b);
  const reference = loud.length ? loud[Math.floor(loud.length * 0.95)] : 1;
  const threshold = Math.max(0.015, reference * 0.12);
  return Uint8Array.from(env, (v) => (v > threshold ? 1 : 0));
}

/** Qué parte (de 0 a 1) del tramo [from, to) segundos tiene voz. */
function voicedFraction(voiced: Uint8Array, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * RATE));
  const b = Math.min(voiced.length, Math.floor(to * RATE));
  if (b <= a) return 0;
  let n = 0;
  for (let i = a; i < b; i++) n += voiced[i];
  return n / (b - a);
}

// --- 2. ¿Va toda la letra adelantada o retrasada? ---------------------------------

/**
 * Prueba a mover toda la letra entre −1,5 y +1,5 s y se queda con el
 * desplazamiento en el que más frases empiezan justo cuando ENTRA la voz
 * (silencio antes, voz después). Si no hay una mejora clara, no la mueve.
 */
function bestOffset(lines: LyricLine[], voiced: Uint8Array): number {
  const starts = lines.filter((l) => l.texto.trim()).map((l) => l.t);
  if (starts.length < 4) return 0;
  const score = (off: number) =>
    starts.reduce(
      (s, t) => s + voicedFraction(voiced, t + off, t + off + 0.4) - voicedFraction(voiced, t + off - 0.4, t + off),
      0,
    );
  const base = score(0);
  let best = 0;
  let bestScore = base;
  for (let off = -MAX_OFFSET; off <= MAX_OFFSET + 1e-9; off += 0.05) {
    const s = score(off);
    if (s > bestScore) {
      bestScore = s;
      best = off;
    }
  }
  // Solo corregimos si gana claramente (si no, nos fiamos de los tiempos de la letra).
  return bestScore - base > 0.05 * starts.length ? Math.round(best * 100) / 100 : 0;
}

// --- 3. Repartir las palabras de una frase ----------------------------------------

/** Sílabas aproximadas: grupos de vocales seguidas ("apagar" → a-pa-gar = 3). */
function syllables(word: string): number {
  return Math.max(1, (word.toLowerCase().match(/[aeiouyáéíóúü]+/g) ?? []).length);
}

/**
 * Coloca las palabras sobre los tramos con voz que hay desde que empieza la
 * frase hasta que empieza la siguiente. Devuelve null si ahí no se oye voz.
 */
function placeOnVoice(words: string[], start: number, next: number, voiced: Uint8Array): LyricWord[] | null {
  const weights = words.map(syllables);
  const total = weights.reduce((a, b) => a + b, 0);
  const expected = Math.max(0.4, total * SECONDS_PER_SYLLABLE) * RATE; // en trocitos

  const lo = Math.max(0, Math.floor((start - 0.25) * RATE)); // la letra a veces se adelanta un poco
  const hi = Math.min(voiced.length, Math.floor((next - 0.05) * RATE));
  // La voz tiene que entrar poco después del inicio de la frase.
  let f = lo;
  const entryLimit = Math.min(hi, Math.floor((start + 1.5) * RATE));
  while (f < entryLimit && !voiced[f]) f++;
  if (f >= entryLimit) return null;

  // Recogemos los tramos con voz hasta que la frase "se acaba": un silencio largo
  // cuando ya hemos oído casi todo lo esperado, o demasiada voz (coros, ad-libs).
  const segments: [number, number][] = [];
  let voicedCount = 0;
  let silence = 0;
  for (; f < hi; f++) {
    if (voiced[f]) {
      const last = segments[segments.length - 1];
      if (last && last[1] === f) last[1] = f + 1;
      else segments.push([f, f + 1]);
      voicedCount++;
      silence = 0;
      if (voicedCount >= expected * 2.5) break;
    } else if (++silence >= LINE_END_SILENCE * RATE && voicedCount >= expected * 0.6) {
      break;
    }
  }
  if (voicedCount < 3) return null;

  // "Estira" el reparto sobre los tramos con voz: fracción 0..1 → segundo.
  const timeAt = (fraction: number): number => {
    let target = fraction * voicedCount;
    for (const [a, b] of segments) {
      if (target <= b - a) return (a + target) / RATE;
      target -= b - a;
    }
    return segments[segments.length - 1][1] / RATE;
  };

  let acc = 0;
  return words.map((w, i) => {
    const t = timeAt(acc / total);
    acc += weights[i];
    const e = Math.max(t + 0.05, timeAt(acc / total));
    return { t: round(t), e: round(e), w };
  });
}

/** Plan B (sin stem de voces, o no se oye voz ahí): reparto uniforme. */
function spreadEvenly(words: string[], start: number, next: number): LyricWord[] {
  const weights = words.map(syllables);
  const total = weights.reduce((a, b) => a + b, 0);
  const length = Math.max(0.3, Math.min(next - start, total * SECONDS_PER_SYLLABLE + 0.3));
  let acc = 0;
  return words.map((w, i) => {
    const t = start + (acc / total) * length;
    acc += weights[i];
    return { t: round(t), e: round(start + (acc / total) * length), w };
  });
}

const round = (x: number) => Math.round(x * 100) / 100;
