/**
 * Mixer = la mesa de mezclas que hay entre los dos platos.
 *
 * Cada plato entra en su propio CANAL, y los canales se juntan en el MASTER:
 *
 *   Plato A → [Bajos → Medios → Agudos] → Filtro → Volumen A → Crossfader A ┐
 *                                                                            ├→ Master → altavoces
 *   Plato B → [Bajos → Medios → Agudos] → Filtro → Volumen B → Crossfader B ┘
 *
 * Todo son nodos de la Web Audio API conectados en cadena, como cables.
 */

/** Las tres bandas del ecualizador. */
export type Band = 'low' | 'mid' | 'high';

/** Cuánto se puede subir o bajar cada banda, en decibelios (dB). */
export const EQ_MIN_DB = -24; // casi silencio: útil para "quitar los bajos"
export const EQ_MAX_DB = 6;

export class Channel {
  /** Aquí conectamos el plato. */
  readonly input: GainNode;
  private readonly eq: Record<Band, BiquadFilterNode>;
  /** Filtro DJ: un paso bajo (quita agudos) y un paso alto (quita graves). */
  private readonly lowpass: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  private readonly fader: GainNode;
  /** Lo controla el crossfader (no lo toques directamente). */
  readonly xfade: GainNode;
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, output: AudioNode) {
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

    // Q = 1: una pequeña "resonancia" en la frecuencia de corte, el sonido
    // típico de filtro de DJ.
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 1;
    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.Q.value = 1;
    this.setFilter(0);

    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();

    // Conectamos la cadena: entrada → bajos → medios → agudos → filtro → volumen → crossfader → salida
    this.input
      .connect(low)
      .connect(mid)
      .connect(high)
      .connect(this.lowpass)
      .connect(this.highpass)
      .connect(this.fader)
      .connect(this.xfade)
      .connect(output);
  }

  /**
   * Filtro DJ, de -1 a 1:
   *  - 0 (centro): sin filtro.
   *  - Hacia -1: paso bajo. Quita agudos y suena "lejano", como desde otra sala.
   *  - Hacia +1: paso alto. Quita graves y suena "fino", ideal para una subida.
   *
   * La frecuencia se mueve de forma exponencial (como el oído percibe los
   * tonos), así todo el recorrido de la rueda se nota igual.
   */
  setFilter(value: number): void {
    const now = this.ctx.currentTime;
    const v = Math.abs(value) < 0.02 ? 0 : value; // zona muerta en el centro
    const lowpassHz = v < 0 ? 20000 * Math.pow(150 / 20000, -v) : 22000;
    const highpassHz = v > 0 ? 20 * Math.pow(6000 / 20, v) : 10;
    this.lowpass.frequency.setTargetAtTime(lowpassHz, now, 0.02);
    this.highpass.frequency.setTargetAtTime(highpassHz, now, 0.02);
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
  private readonly master: GainNode;
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.a = new Channel(ctx, this.master);
    this.b = new Channel(ctx, this.master);
    this.setCrossfader(0.5);
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

  /** Volumen general, de 0 a 1. */
  setMasterVolume(value: number): void {
    this.master.gain.setTargetAtTime(value * value, this.ctx.currentTime, 0.01);
  }
}
