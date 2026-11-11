/**
 * Detector de BPM (golpes por minuto).
 *
 * Cómo funciona, en 3 pasos:
 *
 * 1. "Envolvente de golpes": recorremos la canción en trocitos de 10 ms y
 *    medimos cuánto SUBE la energía de un trocito al siguiente. Cada golpe
 *    (bombo, caja, palmada) es una subida brusca, así que obtenemos una
 *    señal con picos donde hay golpes. Miramos el sonido completo y, aparte,
 *    solo los graves, donde está el bombo.
 *
 * 2. "¿Cada cuánto se repite?": comparamos esa señal consigo misma desplazada
 *    (autocorrelación). Si los golpes se repiten cada 0,5 s, al desplazarla
 *    0,5 s coincide muy bien → 120 BPM. Probamos todos los BPM entre 70 y 180.
 *    En caso de duda entre uno y su doble (73,5 o 147), preferimos el que
 *    está más cerca de 120, que es lo habitual en música de baile.
 *
 * 3. "Afinar": con el BPM aproximado, probamos valores muy cercanos (de 0,01
 *    en 0,01) y nos quedamos con el que hace coincidir mejor TODOS los golpes
 *    de la canción. Así salen valores precisos como 124,00.
 *
 * Si la canción tiene stems, se usa el de batería: sin voces ni melodía
 * molestando, el resultado es mucho más fiable.
 *
 * Hay una copia de este mismo cálculo en Python, en el preparador
 * (tools/preparador/preparar.py), para que los dos den el mismo resultado.
 */

const MIN_BPM = 70;
const MAX_BPM = 180;
const FRAMES_PER_SECOND = 100; // trocitos de 10 ms

/** Devuelve el BPM o null si no encuentra un ritmo claro. */
export function detectBpm(buffers: AudioBuffer[]): number | null {
  if (!buffers.length) return null;
  const channels = buffers.flatMap((b) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
  const length = Math.min(...buffers.map((b) => b.length));
  return bpmFromChannels(channels, length, buffers[0].sampleRate);
}

/** Igual que detectBpm, pero con los datos "en crudo" (útil para pruebas). */
export function bpmFromChannels(channels: Float32Array[], length: number, sampleRate: number): number | null {
  const envelope = onsetEnvelope(channels, length, sampleRate);
  if (envelope.length < FRAMES_PER_SECOND * 10) return null; // menos de 10 s: no fiable

  const coarse = coarseBpm(envelope);
  if (coarse === null) return null;
  const fine = refineBpm(envelope, coarse);

  // Si está a un pelo de un número entero (lo normal en música electrónica), lo redondeamos.
  const rounded = Math.round(fine);
  return Math.abs(fine - rounded) < 0.08 ? rounded : Math.round(fine * 100) / 100;
}

// --- Paso 1: envolvente de golpes ------------------------------------------------

function onsetEnvelope(channels: Float32Array[], length: number, sampleRate: number): Float32Array {
  const hop = Math.round(sampleRate / FRAMES_PER_SECOND);
  const frames = Math.floor(length / hop);
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);

  // Filtro paso bajo muy simple (~150 Hz) para quedarnos con los graves.
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let eFull = 0;
    let eLow = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      lp += alpha * (v - lp);
      eFull += v * v;
      eLow += lp * lp;
    }
    full[f] = Math.log1p(1000 * (eFull / hop));
    low[f] = Math.log1p(1000 * (eLow / hop));
  }

  // Nos quedamos solo con las SUBIDAS de energía.
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, full[f] - full[f - 1]) + Math.max(0, low[f] - low[f - 1]);
  }

  // Restamos la media local (1 s) para que solo cuenten los picos.
  const window = FRAMES_PER_SECOND;
  const result = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += onset[f];
    if (f >= window) sum -= onset[f - window];
    const mean = sum / Math.min(f + 1, window);
    result[f] = Math.max(0, onset[f] - mean);
  }
  return result;
}

// --- Paso 2: BPM aproximado -------------------------------------------------------

function coarseBpm(env: Float32Array): number | null {
  const maxLag = Math.ceil(((FRAMES_PER_SECOND * 60) / MIN_BPM) * 4) + 2;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (env.length - lag);
  }
  const at = (lag: number) => {
    const i = Math.floor(lag);
    const t = lag - i;
    return ac[i] * (1 - t) + ac[i + 1] * t;
  };

  let best: number | null = null;
  let bestScore = 0;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.1) {
    const period = (FRAMES_PER_SECOND * 60) / bpm;
    // Puntuamos el golpe y sus múltiplos (1, 2, 3 y 4 golpes después).
    let score = at(period) + at(2 * period) + 0.5 * at(3 * period) + 0.5 * at(4 * period);
    // Preferencia suave por tempos cercanos a 120 BPM.
    const octaves = Math.log2(bpm / 120);
    score *= Math.exp(-0.5 * (octaves / 0.9) ** 2);
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return best;
}

// --- Paso 3: afinar ---------------------------------------------------------------

function refineBpm(env: Float32Array, coarse: number): number {
  let best = coarse;
  let bestScore = -1;
  for (let bpm = coarse - 1.5; bpm <= coarse + 1.5; bpm += 0.01) {
    const period = (FRAMES_PER_SECOND * 60) / bpm;
    // Probamos dónde cae el primer golpe ("fase") y sumamos todos los golpes.
    for (let phase = 0; phase < period; phase += 1) {
      let s = 0;
      for (let pos = phase; pos < env.length - 1; pos += period) {
        const i = Math.floor(pos);
        const t = pos - i;
        s += env[i] * (1 - t) + env[i + 1] * t;
      }
      if (s > bestScore) {
        bestScore = s;
        best = bpm;
      }
    }
  }
  return best;
}
