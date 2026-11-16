/**
 * Mixer = la mesa de mezclas que hay entre los dos platos.
 *
 * Cada plato entra en su propio CANAL, y los canales se juntan en el MASTER:
 *
 *   Plato A → Gain → [Bajos → Medios → Agudos] → Filtro ─┬→ Volumen A → Crossfader A ┐
 *                                                        └→ CUE A ───────────┐       ├→ Master → altavoces
 *   Plato B → Gain → [Bajos → Medios → Agudos] → Filtro ─┬→ Volumen B → Crossfader B ┘   │
 *                                                        └→ CUE B ───────────┤           │
 *                                                                            ▼           ▼
 *                                                      CASCOS = mezcla de (CUE) y (master)
 *
 * PRE-ESCUCHA (CUE de auriculares): con el botón CUE de un canal, ese canal
 * suena en los CASCOS aunque su fader esté abajo (se coge ANTES del fader).
 * Así preparas la siguiente canción sin que la oiga el público. La rueda
 * "mezcla" de los cascos decide cuánto oyes de lo pre-escuchado y cuánto del master.
 * Por dónde sale cada cosa (altavoces / cascos) lo decide outputs.ts.
 *
 * GAIN (ganancia): iguala el volumen de canciones grabadas más fuertes o más
 * flojas, ANTES de todo lo demás. Así el fader de volumen de las dos queda
 * en el mismo sitio y el ecualizador trabaja con un nivel parecido.
 *
 * Todo son nodos de la Web Audio API conectados en cadena, como cables.
 */

import { ColorFx, type CfxType } from './cfx';

/** Las tres bandas del ecualizador. */
export type Band = 'low' | 'mid' | 'high';

/** Cuánto se puede subir o bajar cada banda, en decibelios (dB). */
export const EQ_MIN_DB = -24; // casi silencio: útil para "quitar los bajos"
export const EQ_MAX_DB = 6;

/** Rango de la ganancia (GAIN), en decibelios. */
export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 12;

export class Channel {
  /** Aquí conectamos el plato. Es también el control de GAIN. */
  readonly input: GainNode;
  private readonly eq: Record<Band, BiquadFilterNode>;
  /** La ruedita del filtro: filtro, eco, espacio… (ver cfx.ts). */
  private readonly cfx: ColorFx;
  /** Cuánto dura un golpe de la canción de este canal (para eco y gate). Lo pone main.ts. */
  beatSeconds: () => number = () => 0.5;
  private readonly fader: GainNode;
  /** Lo controla el crossfader (no lo toques directamente). */
  readonly xfade: GainNode;
  /** Envío a los cascos (pre-escucha): 1 = CUE encendido, 0 = apagado. */
  private readonly cueSend: GainNode;
  /** ¿Está la pre-escucha (CUE de auriculares) de este canal encendida? */
  cueOn = false;
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, output: AudioNode, cueBus: AudioNode) {
    this.ctx = ctx;
    this.input = ctx.createGain();

    // Un filtro por banda. "shelf" sube/baja todo lo que queda por debajo
    // (bajos) o por encima (agudos) de una frecuencia; "peaking" actúa en
    // una zona alrededor de una frecuencia (medios).
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;

    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;

    this.eq = { low, mid, high };

    this.cfx = new ColorFx(ctx, () => this.beatSeconds());

    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();

    // Conectamos la cadena: entrada → bajos → medios → agudos → filtro/CFX → volumen → crossfader → salida
    this.input.connect(low).connect(mid).connect(high).connect(this.cfx.input);
    this.cfx.output.connect(this.fader).connect(this.xfade).connect(output);

    // Pre-escucha: se coge ANTES del fader, así se oye en los cascos aunque el
    // fader esté abajo (que es justo cuando la necesitas).
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.cfx.output.connect(this.cueSend).connect(cueBus);
  }

  /** Enciende o apaga la pre-escucha de este canal en los cascos. */
  setCue(on: boolean): void {
    this.cueOn = on;
    this.cueSend.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** Qué hace la ruedita del filtro (filtro, eco, espacio…). */
  setCfxType(type: CfxType): void {
    this.cfx.setType(type);
  }

  /**
   * Ganancia en dB (de -12 a +12; 0 = sin cambios).
   * Los decibelios no son lineales: +6 dB es casi el doble de amplitud,
   * -6 dB casi la mitad. De ahí la fórmula 10^(dB/20).
   */
  setGain(db: number): void {
    this.input.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.01);
  }

  /**
   * La ruedita del filtro, de -1 a 1:
   *  - 0 (centro): sin efecto.
   *  - Hacia -1: versión "oscura" (con FILTRO: paso bajo, quita agudos, suena lejano).
   *  - Hacia +1: versión "brillante" (con FILTRO: paso alto, quita graves, ideal para una subida).
   * Qué efecto exacto suena lo elige setCfxType (botón FX).
   */
  setFilter(value: number): void {
    this.cfx.setValue(value);
  }

  /** Ecualizador: `db` entre EQ_MIN_DB y EQ_MAX_DB; 0 = sin cambios. */
  setEq(band: Band, db: number): void {
    this.eq[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  /**
   * Volumen del canal, de 0 a 1. Lo elevamos al cuadrado porque el oído no
   * percibe el volumen de forma lineal: así el fader se siente más natural.
   */
  setVolume(value: number): void {
    this.fader.gain.setTargetAtTime(value * value, this.ctx.currentTime, 0.01);
  }
}

export class Mixer {
  readonly a: Channel;
  readonly b: Channel;
  /** Suma de los dos canales (y el sampler), ANTES del volumen master. */
  private readonly mainSum: GainNode;
  private readonly master: GainNode;
  /** Lo que sale hacia los altavoces (ya con el volumen master). Lo conecta outputs.ts. */
  readonly masterOut: GainNode;
  /** Lo que sale hacia los cascos. Lo conecta outputs.ts. */
  readonly headphonesOut: GainNode;
  /** Suma de los canales con CUE encendido. */
  private readonly cueBus: GainNode;
  /** Cuánto de lo pre-escuchado y cuánto del master llega a los cascos. */
  private readonly hpCue: GainNode;
  private readonly hpMaster: GainNode;
  private hpMix = 0; // empieza del todo en CUE: solo lo pre-escuchado
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.mainSum = ctx.createGain();
    this.master = ctx.createGain();
    this.mainSum.connect(this.master);
    // Pieza aparte para la salida: outputs.ts la conecta y desconecta al cambiar
    // de salida sin tocar lo demás (p. ej. el medidor del vigilante de audio).
    this.masterOut = ctx.createGain();
    this.master.connect(this.masterOut);

    // Cascos = (canales con CUE) × mezcla + (master) × (1 − mezcla), y su volumen.
    this.cueBus = ctx.createGain();
    this.hpCue = ctx.createGain();
    this.hpMaster = ctx.createGain();
    this.headphonesOut = ctx.createGain();
    this.headphonesOut.gain.value = 0.64; // volumen de cascos al 80 %
    this.cueBus.connect(this.hpCue).connect(this.headphonesOut);
    this.mainSum.connect(this.hpMaster).connect(this.headphonesOut);

    this.a = new Channel(ctx, this.mainSum, this.cueBus);
    this.b = new Channel(ctx, this.mainSum, this.cueBus);
    this.setCrossfader(0.5);
    this.applyHeadphonesMix();
  }

  // --- Cascos (pre-escucha) ------------------------------------------------------

  /** CUE de auriculares de un canal. */
  setCue(channel: 'a' | 'b', on: boolean): void {
    this[channel].setCue(on);
    this.applyHeadphonesMix();
  }

  /** Volumen de los cascos, de 0 a 1 (al cuadrado, como los faders). */
  setHeadphonesVolume(value: number): void {
    this.headphonesOut.gain.setTargetAtTime(value * value, this.ctx.currentTime, 0.01);
  }

  /** Rueda MEZCLA de los cascos: 0 = solo lo pre-escuchado (CUE), 1 = solo el master. */
  setHeadphonesMix(value: number): void {
    this.hpMix = value;
    this.applyHeadphonesMix();
  }

  /**
   * Como en una mesa de verdad: en los cascos suena SOLO lo que tiene CUE
   * encendido, más la cantidad de master que pida la rueda MEZCLA.
   * (Antes, sin ningún CUE, mandábamos el master a los cascos: confundía,
   * porque la canción sonaba en los cascos aunque no la pre-escucharas.)
   * Curva de potencia constante, como el crossfader.
   */
  private applyHeadphonesMix(): void {
    const mix = this.hpMix;
    const now = this.ctx.currentTime;
    this.hpCue.gain.setTargetAtTime(Math.cos((mix * Math.PI) / 2), now, 0.01);
    this.hpMaster.gain.setTargetAtTime(Math.sin((mix * Math.PI) / 2), now, 0.01);
  }

  /**
   * Crossfader: 0 = solo A, 0.5 = los dos, 1 = solo B.
   *
   * Usamos una curva de "potencia constante" (seno y coseno): en el centro
   * los dos canales suenan a ~71 % en vez de al 50 %, así el volumen total
   * no baja a mitad de la transición.
   */
  setCrossfader(position: number): void {
    const angle = position * (Math.PI / 2);
    const now = this.ctx.currentTime;
    this.a.xfade.gain.setTargetAtTime(Math.cos(angle), now, 0.01);
    this.b.xfade.gain.setTargetAtTime(Math.sin(angle), now, 0.01);
  }

  /** Qué hacen las ruedas del filtro de los dos canales (botón FX). */
  setCfxType(type: CfxType): void {
    this.a.setCfxType(type);
    this.b.setCfxType(type);
  }

  /**
   * Conecta algo directo al master, sin pasar por ningún canal ni por el
   * crossfader (lo usa el sampler: suena igual hagas lo que hagas con los faders).
   */
  connectToMaster(node: AudioNode): void {
    node.connect(this.mainSum);
  }

  /** Conecta un "medidor" a la salida master (para vigilar lo que sale). */
  tap(node: AudioNode): void {
    this.master.connect(node);
  }

  /** Volumen general, de 0 a 1. */
  setMasterVolume(value: number): void {
    this.master.gain.setTargetAtTime(value * value, this.ctx.currentTime, 0.01);
  }
}
