/**
 * Efectos (FX) de cada plato.
 *
 * Cada plato tiene 3 RANURAS de efectos en cadena:
 *
 *   Plato → ranura 1 → ranura 2 → ranura 3 → canal del mixer
 *
 * En cada ranura eliges un efecto, lo enciendes o apagas y ajustas la
 * cantidad (0 a 100 %). Por dentro, cada ranura mezcla dos caminos:
 *
 *   entrada ─┬─ seco (sin efecto) ──────────┬─→ salida
 *            └─ efecto → mojado (con efecto)─┘
 *
 * Los efectos con ritmo (Echo, Wah-wah) van al compás del BPM de la canción.
 */

export type FxName = 'flanger' | 'reverb' | 'wahwah' | 'echo' | 'phaser' | 'lofi';

export const FX_LIST: { name: FxName; label: string }[] = [
  { name: 'flanger', label: 'Flanger' },
  { name: 'reverb', label: 'Reverb' },
  { name: 'wahwah', label: 'Wah-wah' },
  { name: 'echo', label: 'Echo' },
  { name: 'phaser', label: 'Phaser' },
  { name: 'lofi', label: 'Lo-Fi' },
];

/** Un efecto ya montado: su entrada, su salida y cómo ajustarlo. */
interface Effect {
  input: AudioNode;
  output: AudioNode;
  /**
   * "insert" = el efecto SUSTITUYE al sonido (Wah-wah, Lo-Fi…): al subir la
   * cantidad, baja el sonido seco. Si no, el efecto se SUMA (Echo, Reverb).
   */
  insert: boolean;
  /**
   * Compensación de volumen: algunos efectos (Flanger, Phaser) suman tanto
   * sonido que todo sube de volumen. Con el efecto al máximo, la salida se
   * multiplica por este número para que suene igual de fuerte que sin él.
   */
  trim?: number;
  /** Ajusta el efecto a la cantidad (0 a 1) y al golpe actual (segundos por golpe). */
  update(amount: number, beatSeconds: number): void;
  /** Desmonta todo (al cambiar de efecto). */
  dispose(): void;
}

const smooth = (param: AudioParam, value: number, ctx: BaseAudioContext) =>
  param.setTargetAtTime(value, ctx.currentTime, 0.03);

/** Un "LFO": un oscilador muy lento que mueve un parámetro arriba y abajo. */
function lfo(ctx: BaseAudioContext, target: AudioParam, depth: number, hz: number) {
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain).connect(target);
  osc.start();
  return { osc, gain };
}

const builders: Record<FxName, (ctx: BaseAudioContext) => Effect> = {
  /** Flanger: copia del sonido con un retraso mínimo que oscila → efecto "avión". */
  flanger(ctx) {
    const input = ctx.createGain();
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.004;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.6;
    const mod = lfo(ctx, delay.delayTime, 0.003, 0.2);
    input.connect(delay);
    delay.connect(feedback).connect(delay);
    return {
      input,
      output: delay,
      insert: false,
      trim: 0.45,
      update(amount) {
        smooth(feedback.gain, 0.3 + 0.4 * amount, ctx);
      },
      dispose() {
        mod.osc.stop();
      },
    };
  },

  /** Reverb: como si sonara en una sala grande. Usa una "huella" de sala inventada. */
  reverb(ctx) {
    const input = ctx.createGain();
    const convolver = ctx.createConvolver();
    const seconds = 2.8;
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c);
      // Ruido que se va apagando: así suena el eco de una sala.
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
    }
    convolver.buffer = impulse;
    input.connect(convolver);
    return { input, output: convolver, insert: false, trim: 0.85, update() {}, dispose() {} };
  },

  /** Wah-wah: un filtro que abre y cierra al ritmo (un golpe por "uaaa"). */
  wahwah(ctx) {
    const input = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 5;
    filter.frequency.value = 900;
    const out = ctx.createGain();
    out.gain.value = 3.8; // el filtro estrecho baja mucho el volumen: lo compensamos
    const mod = lfo(ctx, filter.frequency, 700, 2);
    input.connect(filter).connect(out);
    return {
      input,
      output: out,
      insert: true,
      update(amount, beatSeconds) {
        smooth(mod.osc.frequency, 1 / beatSeconds, ctx);
        smooth(mod.gain.gain, 300 + 500 * amount, ctx);
      },
      dispose() {
        mod.osc.stop();
      },
    };
  },

  /** Echo: repite el sonido cada medio golpe, cada vez más flojito. */
  echo(ctx) {
    const input = ctx.createGain();
    const delay = ctx.createDelay(4);
    const feedback = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 5000; // cada repetición, un poco más apagada
    input.connect(delay);
    delay.connect(tone).connect(feedback).connect(delay);
    return {
      input,
      output: delay,
      insert: false,
      update(amount, beatSeconds) {
        smooth(delay.delayTime, beatSeconds / 2, ctx);
        smooth(feedback.gain, 0.25 + 0.4 * amount, ctx);
      },
      dispose() {},
    };
  },

  /** Phaser: varios filtros que desplazan el sonido y lo hacen "girar". */
  phaser(ctx) {
    const input = ctx.createGain();
    let node: AudioNode = input;
    const mods: ReturnType<typeof lfo>[] = [];
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 700;
      mods.push(lfo(ctx, ap.frequency, 500, 0.35));
      node.connect(ap);
      node = ap;
    }
    return {
      input,
      output: node,
      insert: false,
      trim: 0.65,
      update() {},
      dispose() {
        mods.forEach((m) => m.osc.stop());
      },
    };
  },

  /** Lo-Fi: menos calidad a propósito (como un disco viejo o una radio). */
  lofi(ctx) {
    const input = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    input.connect(shaper).connect(tone);
    let bits = 0;
    return {
      input,
      output: tone,
      insert: true,
      update(amount) {
        // De 8 a 3 "bits": cuantos menos, más escalones y más "sucio".
        const next = Math.round(8 - 5 * amount);
        if (next !== bits) {
          bits = next;
          const steps = 2 ** bits;
          const curve = new Float32Array(1024);
          for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            curve[i] = Math.round(x * steps) / steps;
          }
          shaper.curve = curve;
        }
        smooth(tone.frequency, 6000 - 4000 * amount, ctx);
      },
      dispose() {},
    };
  },
};

/** Una ranura de efecto. */
export class FxSlot {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly ctx: BaseAudioContext;
  private effect: Effect;
  private timer: ReturnType<typeof setInterval> | null = null;

  name: FxName;
  on = false;
  amount = 0.5;

  /** `getBeatSeconds`: cuánto dura un golpe ahora mismo (para los efectos con ritmo). */
  constructor(
    ctx: BaseAudioContext,
    name: FxName,
    private readonly getBeatSeconds: () => number,
  ) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
    this.name = name;
    this.effect = this.build(name);
  }

  private build(name: FxName): Effect {
    const effect = builders[name](this.ctx);
    this.input.connect(effect.input);
    effect.output.connect(this.wet);
    return effect;
  }

  /** Cambia el efecto de esta ranura. */
  setEffect(name: FxName): void {
    const old = this.effect;
    this.input.disconnect(old.input);
    old.output.disconnect();
    old.dispose();
    this.name = name;
    this.effect = this.build(name);
    this.apply();
  }

  setOn(on: boolean): void {
    this.on = on;
    this.apply();
    // Mientras está encendido, revisamos el BPM de vez en cuando (por si cambia el tempo).
    if (on && !this.timer) this.timer = setInterval(() => this.apply(), 250);
    if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setAmount(amount: number): void {
    this.amount = amount;
    this.apply();
  }

  private apply(): void {
    const level = this.on ? this.amount : 0;
    this.effect.update(this.amount, this.getBeatSeconds());
    smooth(this.wet.gain, level, this.ctx);
    smooth(this.dry.gain, this.effect.insert ? 1 - level : 1, this.ctx);
    const trim = this.effect.trim ?? 1;
    smooth(this.output.gain, 1 - (1 - trim) * level, this.ctx);
  }
}

/** Las 3 ranuras de un plato, ya conectadas en cadena. */
export class FxRack {
  readonly input: AudioNode;
  readonly slots: FxSlot[];

  constructor(ctx: BaseAudioContext, output: AudioNode, getBeatSeconds: () => number) {
    const defaults: FxName[] = ['flanger', 'reverb', 'wahwah'];
    this.slots = defaults.map((name) => new FxSlot(ctx, name, getBeatSeconds));
    this.input = this.slots[0].input;
    for (let i = 0; i < this.slots.length - 1; i++) this.slots[i].output.connect(this.slots[i + 1].input);
    this.slots[this.slots.length - 1].output.connect(output);
  }
}
