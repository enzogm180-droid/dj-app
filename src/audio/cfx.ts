/**
 * EFECTOS DE LA RUEDITA DEL FILTRO ("Color FX" o CFX)
 *
 * La rueda del filtro de cada canal del mixer ya no es solo un filtro: con el
 * botón FX eliges QUÉ hace. Igual para las dos ruedas (A y B).
 *
 *   Centro = apagado. Cuanto más giras (a un lado u otro), más efecto.
 *   Izquierda = versión "oscura" (quita agudos), derecha = "brillante" (quita graves).
 *
 *   Banco 1:  FILTRO · ECO · ESPACIO · JET
 *   Banco 2 (con SHIFT):  RUIDO · GATE · PHASER · CRUSH
 *
 * Cómo está montado (todo dentro del canal, entre el EQ y el fader):
 *
 *   entrada ─→ paso bajo ─→ paso alto ─┬─→ "seco" ──────────────┬─→ gate ─→ salida
 *                                      ├─→ eco ─→ filtro ───────┤
 *                                      ├─→ reverb ─→ filtro ────┤
 *                                      ├─→ crush ───────────────┤
 *                                      ├─→ jet (flanger) ───────┤
 *                                      └─→ phaser ──────────────┤
 *                         ruido ─→ filtro del ruido ────────────┘
 *
 * Todos los efectos existen siempre; el que no se usa tiene su volumen a 0.
 */

/*
 * Orden elegido según lo que más se usa al pinchar (y cómo suena):
 *   Banco 1 (los imprescindibles):  Filtro · Eco · Espacio · Jet
 *   Banco 2 (con SHIFT):            Ruido · Gate · Phaser · Crush
 * (El wah-wah de los antiguos efectos del plato se quitó: hoy casi no se usa.)
 */
export const CFX_TYPES = [
  { id: 'filtro', label: 'Filtro' },
  { id: 'eco', label: 'Eco' },
  { id: 'espacio', label: 'Espacio' },
  { id: 'jet', label: 'Jet' },
  { id: 'ruido', label: 'Ruido' },
  { id: 'gate', label: 'Gate' },
  { id: 'phaser', label: 'Phaser' },
  { id: 'crush', label: 'Crush' },
] as const;

export type CfxType = (typeof CFX_TYPES)[number]['id'];

/** Cambio suave de un parámetro (sin clics). */
function to(param: AudioParam, value: number, ctx: BaseAudioContext, time = 0.03): void {
  param.setTargetAtTime(value, ctx.currentTime, time);
}

/** De `a` a `b` según `t` (0 a 1), en escala "de oído" (exponencial). */
const expLerp = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

export class ColorFx {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly ctx: AudioContext;
  private readonly getBeatSeconds: () => number;

  private readonly lowpass: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  private readonly dry: GainNode;
  private readonly gate: GainNode;
  private readonly gateLfo: OscillatorNode;
  private readonly gateDepth: GainNode;

  private readonly echoSend: GainNode;
  private readonly echoDelay: DelayNode;
  private readonly echoFeedback: GainNode;
  private readonly echoFilter: BiquadFilterNode;

  private readonly reverbSend: GainNode;
  private readonly reverbFilter: BiquadFilterNode;

  private readonly crushSend: GainNode;
  private readonly crusher: WaveShaperNode;
  private crushBits = 0;

  private readonly jetSend: GainNode;
  private readonly jetDelay: DelayNode;
  private readonly jetFeedback: GainNode;

  private readonly phaserSend: GainNode;
  private readonly phaserStages: BiquadFilterNode[] = [];

  private readonly noiseGain: GainNode;
  private readonly noiseFilter: BiquadFilterNode;

  private type: CfxType = 'filtro';
  private value = 0;

  constructor(ctx: AudioContext, getBeatSeconds: () => number) {
    this.ctx = ctx;
    this.getBeatSeconds = getBeatSeconds;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // Filtro DJ (paso bajo + paso alto), como antes.
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 1;
    this.lowpass.frequency.value = 22000;
    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.Q.value = 1;
    this.highpass.frequency.value = 10;
    this.input.connect(this.lowpass).connect(this.highpass);

    // Todo se junta en "gate" (que normalmente deja pasar todo).
    this.gate = ctx.createGain();
    this.gate.connect(this.output);
    this.dry = ctx.createGain();
    this.highpass.connect(this.dry).connect(this.gate);

    // GATE: un oscilador cuadrado abre y cierra el volumen al ritmo.
    this.gateLfo = ctx.createOscillator();
    this.gateLfo.type = 'square';
    this.gateDepth = ctx.createGain();
    this.gateDepth.gain.value = 0;
    this.gateLfo.connect(this.gateDepth).connect(this.gate.gain);
    this.gateLfo.start();

    // ECO: repeticiones al ritmo (cada 3/4 de golpe), cada vez más flojas.
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.echoDelay = ctx.createDelay(4);
    this.echoFeedback = ctx.createGain();
    this.echoFilter = ctx.createBiquadFilter();
    this.highpass.connect(this.echoSend).connect(this.echoDelay);
    this.echoDelay.connect(this.echoFilter).connect(this.echoFeedback).connect(this.echoDelay);
    this.echoFilter.connect(this.gate);

    // ESPACIO: reverb de sala grande (una "huella" de sala inventada).
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    const convolver = ctx.createConvolver();
    const seconds = 3.2;
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
    }
    convolver.buffer = impulse;
    this.reverbFilter = ctx.createBiquadFilter();
    this.highpass.connect(this.reverbSend).connect(convolver).connect(this.reverbFilter).connect(this.gate);

    // CRUSH: sonido "roto", con menos calidad (menos "bits").
    this.crushSend = ctx.createGain();
    this.crushSend.gain.value = 0;
    this.crusher = ctx.createWaveShaper();
    this.highpass.connect(this.crushSend).connect(this.crusher).connect(this.gate);

    // JET: flanger (una copia con un retraso mínimo que se realimenta): sonido de avión.
    this.jetSend = ctx.createGain();
    this.jetSend.gain.value = 0;
    this.jetDelay = ctx.createDelay(0.05);
    this.jetFeedback = ctx.createGain();
    this.jetFeedback.gain.value = 0.6;
    this.highpass.connect(this.jetSend).connect(this.jetDelay);
    this.jetDelay.connect(this.jetFeedback).connect(this.jetDelay);
    this.jetDelay.connect(this.gate);
    // Un vaivén lento (una ida y vuelta cada 4 s) mueve el retraso un poquito:
    // así el "avión" está vivo aunque no toques la rueda.
    const jetLfo = ctx.createOscillator();
    jetLfo.frequency.value = 0.25;
    const jetLfoDepth = ctx.createGain();
    jetLfoDepth.gain.value = 0.0012; // ±1,2 ms
    jetLfo.connect(jetLfoDepth).connect(this.jetDelay.delayTime);
    jetLfo.start();

    // PHASER: 4 filtros que "desplazan" el sonido; la rueda mueve su frecuencia.
    this.phaserSend = ctx.createGain();
    this.phaserSend.gain.value = 0;
    let node: AudioNode = this.phaserSend;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      this.phaserStages.push(ap);
      node.connect(ap);
      node = ap;
    }
    this.highpass.connect(this.phaserSend);
    node.connect(this.gate);

    // RUIDO: ruido blanco (como el de una radio sin emisora) que pasa por un filtro.
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.Q.value = 2;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noiseSource.connect(this.noiseFilter).connect(this.noiseGain).connect(this.gate);
    noiseSource.start();

    // Los efectos con ritmo (eco y gate) siguen el BPM aunque cambie el tempo.
    setInterval(() => {
      if (this.type === 'eco' || this.type === 'gate') this.apply();
    }, 250);
    this.apply();
  }

  /** Elige qué hace la rueda (el valor de la rueda se mantiene). */
  setType(type: CfxType): void {
    this.type = type;
    this.apply();
  }

  /** La rueda: de -1 (izquierda) a 1 (derecha); 0 = apagado. */
  setValue(value: number): void {
    this.value = Math.abs(value) < 0.02 ? 0 : value; // zona muerta en el centro
    this.apply();
  }

  private apply(): void {
    const ctx = this.ctx;
    const v = this.value;
    const a = Math.abs(v); // cuánto efecto (0 a 1)
    const dark = v < 0; // izquierda = oscuro (paso bajo), derecha = brillante (paso alto)
    const type = this.type;
    const beat = Math.max(0.2, Math.min(2, this.getBeatSeconds()));

    // 1. Filtro principal: a tope con FILTRO; a medias con RUIDO (acompaña la subida).
    const filterAmount = type === 'filtro' ? v : type === 'ruido' ? v * 0.6 : 0;
    to(this.lowpass.frequency, filterAmount < 0 ? expLerp(20000, 150, -filterAmount) : 22000, ctx, 0.02);
    to(this.highpass.frequency, filterAmount > 0 ? expLerp(20, 6000, filterAmount) : 10, ctx, 0.02);

    // 2. Todos los envíos a 0 menos el del efecto elegido.
    to(this.echoSend.gain, type === 'eco' ? a : 0, ctx);
    to(this.reverbSend.gain, type === 'espacio' ? a * 1.4 : 0, ctx);
    to(this.crushSend.gain, type === 'crush' ? a : 0, ctx);
    to(this.jetSend.gain, type === 'jet' ? Math.min(1, a * 2) * 0.5 : 0, ctx);
    to(this.phaserSend.gain, type === 'phaser' && a > 0 ? 0.8 : 0, ctx);
    to(this.noiseGain.gain, type === 'ruido' ? a * a * 0.35 : 0, ctx);
    // El sonido "seco" baja un poco cuando el efecto lo sustituye (crush, phaser)
    // o se le suma mucho (jet: sin esto, a tope saturaba).
    const dryLevel =
      type === 'crush' ? 1 - 0.85 * a
      : type === 'phaser' && a > 0 ? 0.6
      : type === 'jet' ? 1 - 0.3 * Math.min(1, a * 2)
      : 1;
    to(this.dry.gain, dryLevel, ctx);

    // 3. Ajustes de cada efecto.
    // Eco: cada 3/4 de golpe; más rueda = más repeticiones. Oscuro o brillante según el lado.
    to(this.echoDelay.delayTime, beat * 0.75, ctx, 0.1);
    to(this.echoFeedback.gain, 0.3 + 0.45 * a, ctx);
    this.echoFilter.type = dark ? 'lowpass' : 'highpass';
    to(this.echoFilter.frequency, dark ? expLerp(5000, 700, a) : expLerp(200, 2500, a), ctx);

    // Espacio: la reverb se filtra según el lado.
    this.reverbFilter.type = dark ? 'lowpass' : 'highpass';
    to(this.reverbFilter.frequency, dark ? expLerp(8000, 1200, a) : expLerp(150, 2000, a), ctx);

    // Crush: de 8 "bits" (casi limpio) a 2 (muy roto).
    const bits = Math.max(2, Math.round(8 - 6 * a));
    if (type === 'crush' && bits !== this.crushBits) {
      this.crushBits = bits;
      const steps = 2 ** bits;
      const curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.round(x * steps) / steps;
      }
      this.crusher.curve = curve;
    }

    // Jet: el retraso del flanger lo mueve la rueda (oscuro = más largo, brillante = más corto).
    // (Nunca por debajo de 1,5 ms: el vaivén resta hasta 1,2 ms y el retraso no puede ser negativo.)
    to(this.jetDelay.delayTime, dark ? 0.0025 + 0.009 * a : 0.0015 + 0.004 * a, ctx, 0.05);

    // Phaser: la rueda mueve los filtros de 200 Hz a 5 kHz.
    for (const ap of this.phaserStages) to(ap.frequency, expLerp(200, 5000, a), ctx, 0.05);

    // Ruido: oscuro = ruido que se apaga hacia graves; brillante = ruido agudo que sube.
    this.noiseFilter.type = dark ? 'lowpass' : 'highpass';
    to(this.noiseFilter.frequency, dark ? expLerp(8000, 300, a) : expLerp(300, 9000, a), ctx);

    // Gate: corta el sonido al ritmo. Izquierda = en corcheas, derecha = en semicorcheas.
    // El volumen oscila entre 1 y (1 - a): "gate" = gain + oscilador × profundidad.
    const gateOn = type === 'gate' && a > 0;
    to(this.gateLfo.frequency, (dark ? 2 : 4) / beat, ctx, 0.05);
    to(this.gateDepth.gain, gateOn ? a / 2 : 0, ctx);
    to(this.gate.gain, gateOn ? 1 - a / 2 : 1, ctx);
  }
}
