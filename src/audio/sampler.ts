/**
 * SAMPLER: 8 sonidos cortos para lanzar con los pads (bocina, sirena…).
 *
 * Los sonidos NO son archivos: se FABRICAN con matemáticas al arrancar la app
 * (ondas, ruido y "envolventes" que suben y bajan el volumen). Así:
 *   - no hay que descargar nada y funciona sin internet,
 *   - no hay problemas de derechos de autor (los hemos hecho nosotros).
 *
 * Suenan directos al MASTER: no pasan por el canal A ni B ni por el
 * crossfader, así que se oyen igual muevas lo que muevas.
 *
 * Volver a pulsar un pad mientras suena = empieza otra vez desde el principio.
 */

export interface SampleInfo {
  name: string;
  /** Color del pad (en la pantalla). */
  color: string;
}

/** Los 8 sonidos, en el orden de los pads (fila de arriba 1-4, de abajo 5-8). */
export const SAMPLES: SampleInfo[] = [
  { name: 'Bocina', color: '#fbbf24' },
  { name: 'Sirena', color: '#fb7185' },
  { name: 'Láser', color: '#22d3ee' },
  { name: 'Subida', color: '#a78bfa' },
  { name: 'Bombo', color: '#f97316' },
  { name: 'Palmada', color: '#f472b6' },
  { name: 'Platillo', color: '#e2e8f0' },
  { name: 'Impacto', color: '#34d399' },
];

export class Sampler extends EventTarget {
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly buffers: AudioBuffer[];
  /** El sonido que está sonando en cada pad (o null). */
  private readonly playing: (AudioBufferSourceNode | null)[] = SAMPLES.map(() => null);

  constructor(ctx: AudioContext, connect: (node: AudioNode) => void) {
    super();
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
    connect(this.output);
    const rate = ctx.sampleRate;
    this.buffers = [airHorn, siren, laser, riser, kick, clap, crash, impact].map((make) => toBuffer(ctx, make(rate)));
  }

  /** Pulsar un pad: suena (o vuelve a empezar si ya sonaba). */
  async trigger(index: number): Promise<void> {
    const buffer = this.buffers[index];
    if (!buffer) return;
    await this.ctx.resume(); // por si es lo primero que suena
    this.playing[index]?.stop();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      if (this.playing[index] === source) {
        this.playing[index] = null;
        this.dispatchEvent(new Event('change'));
      }
    };
    source.start();
    this.playing[index] = source;
    this.dispatchEvent(new Event('change'));
  }

  isPlaying(index: number): boolean {
    return this.playing[index] !== null;
  }
}

// --- Fábrica de sonidos ---------------------------------------------------------
// Cada función devuelve las muestras (números de -1 a 1) de un sonido.

function toBuffer(ctx: AudioContext, samples: Float32Array): AudioBuffer {
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

const TAU = Math.PI * 2;
const noise = () => Math.random() * 2 - 1;
/** Onda de "sierra" (suena áspera, como una trompeta o una bocina). */
const saw = (phase: number) => 2 * (phase - Math.floor(phase + 0.5));

/** Filtro sencillo que deja pasar los graves (cuanto más bajo `k`, más apagado). */
function lowpass(data: Float32Array, k: number): Float32Array {
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    y += k * (data[i] - y);
    data[i] = y;
  }
  return data;
}

/** Filtro que deja pasar los agudos (quita lo grave). */
function highpass(data: Float32Array, k: number): Float32Array {
  let low = 0;
  for (let i = 0; i < data.length; i++) {
    low += k * (data[i] - low);
    data[i] -= low;
  }
  return data;
}

/** Ajusta el volumen para que el pico quede en `peak`. */
function normalize(data: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
  return data;
}

/** Bocina de estadio: 3 toques cortos y uno largo, con 3 notas a la vez. */
function airHorn(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 1.7));
  const notes = [233, 293.7, 349.2]; // un acorde
  // [inicio, fin] de cada toque, en segundos
  const blasts = [
    [0, 0.16],
    [0.22, 0.38],
    [0.44, 0.6],
    [0.68, 1.65],
  ];
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const blast = blasts.find(([a, b]) => t >= a && t < b);
    if (!blast) continue;
    const env = Math.min(1, (t - blast[0]) / 0.01, (blast[1] - t) / 0.03);
    let v = 0;
    for (const f of notes) v += saw(t * f * (1 + 0.004 * Math.sin(TAU * 6 * t)));
    out[i] = v * env;
  }
  return normalize(lowpass(out, 0.25));
}

/** Sirena que sube y baja. */
function siren(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 2.2));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const freq = 850 + 450 * Math.sin(TAU * 1.4 * t);
    phase += freq / rate;
    const env = Math.min(1, t / 0.05, (2.2 - t) / 0.3);
    out[i] = (Math.sin(TAU * phase) + 0.3 * Math.sign(Math.sin(TAU * phase))) * env;
  }
  return normalize(lowpass(out, 0.3), 0.75);
}

/** "Piu piu": tres disparos de láser que bajan de tono muy rápido. */
function laser(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 0.9));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const local = t % 0.28;
    if (local > 0.22) continue;
    const freq = 2400 * Math.exp(-local * 14) + 150;
    phase += freq / rate;
    out[i] = saw(phase) * Math.exp(-local * 9);
  }
  return normalize(lowpass(out, 0.5), 0.7);
}

/** Subida: ruido que se va aclarando y un tono que sube (para antes de un "drop"). */
function riser(rate: number): Float32Array {
  const seconds = 4;
  const out = new Float32Array(Math.floor(rate * seconds));
  let low = 0;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const progress = t / seconds;
    const k = 0.02 + 0.5 * progress * progress; // el ruido se abre poco a poco
    low += k * (noise() - low);
    phase += (200 + 1800 * progress * progress) / rate;
    const env = progress * progress * Math.min(1, (seconds - t) / 0.05);
    out[i] = (low * 0.8 + Math.sin(TAU * phase) * 0.35) * env;
  }
  return normalize(out, 0.8);
}

/** Bombo: un golpe grave que baja de tono. */
function kick(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 0.6));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    phase += (45 + 110 * Math.exp(-t * 30)) / rate;
    out[i] = Math.sin(TAU * phase) * Math.exp(-t * 6) + (t < 0.004 ? noise() * 0.4 : 0);
  }
  return normalize(out, 0.95);
}

/** Palmada: tres ráfagas de ruido muy seguidas y una cola corta. */
function clap(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 0.4));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let env = 0;
    for (const start of [0, 0.012, 0.024]) if (t >= start) env = Math.max(env, Math.exp(-(t - start) * 90));
    env = Math.max(env, t >= 0.03 ? 0.35 * Math.exp(-(t - 0.03) * 18) : 0);
    out[i] = noise() * env;
  }
  return normalize(lowpass(highpass(out, 0.08), 0.5), 0.8);
}

/** Platillo: ruido muy agudo que se apaga despacio. */
function crash(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 2.5));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = noise() * Math.exp(-t * 2.2) * Math.min(1, t / 0.002);
  }
  return normalize(highpass(out, 0.25), 0.6);
}

/** Impacto: un golpe enorme y grave con una explosión de ruido. */
function impact(rate: number): Float32Array {
  const out = new Float32Array(Math.floor(rate * 2.5));
  let phase = 0;
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    phase += (30 + 70 * Math.exp(-t * 4)) / rate;
    low += 0.05 * (noise() - low);
    out[i] = Math.sin(TAU * phase) * Math.exp(-t * 1.6) + low * 1.5 * Math.exp(-t * 5);
  }
  return normalize(out, 0.95);
}
