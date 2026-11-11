/**
 * Deck = un "plato" de DJ.
 *
 * Se encarga solo del AUDIO: cargar una canción, reproducirla, pausarla,
 * saltar a un punto, cambiar el tempo y controlar los stems. No sabe nada de
 * botones ni de pantallas; eso lo hace la interfaz (deck-view.ts).
 *
 * Una canción puede cargarse de dos formas:
 *  - NORMAL: un solo archivo (una "capa").
 *  - CON STEMS: cuatro archivos (voces, batería, bajo y melodía), que suenan
 *    a la vez y perfectamente sincronizados. Cada uno tiene su propio volumen,
 *    así que podemos quitar o bajar cualquier parte.
 *
 * Cómo suena (Web Audio API):
 *   capa 1 → volumen capa 1 ┐
 *   capa 2 → volumen capa 2 ├→ key lock (mantiene el tono) → canal del mixer
 *   ...                     ┘
 *
 * Un AudioBufferSourceNode solo puede arrancarse UNA vez. Por eso, cada vez
 * que pulsamos play creamos fuentes nuevas que empiezan en la posición guardada.
 */
import { detectBpm } from './bpm';
import keylockUrl from './keylock-processor.ts?worker&url';

/** Las 4 partes que genera el preparador. */
export type StemName = 'vocals' | 'drums' | 'bass' | 'other';
export const STEM_NAMES: StemName[] = ['vocals', 'other', 'bass', 'drums'];

/** Los 3 grupos que controlan las ruedas del mixer en modo STEMS. */
export type StemGroup = 'vocal' | 'instru' | 'beat';
export const STEM_GROUPS: Record<StemGroup, StemName[]> = {
  vocal: ['vocals'],
  instru: ['other', 'bass'], // melodía + bajo
  beat: ['drums'],
};

/** Hay que llamarlo una vez al arrancar la app, antes de crear los platos. */
export async function setupDecks(ctx: AudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(keylockUrl);
}

interface Layer {
  name: StemName | 'main';
  buffer: AudioBuffer;
  gain: GainNode;
}

export class Deck extends EventTarget {
  private readonly ctx: AudioContext;
  /** Todas las capas se juntan aquí antes de pasar por el key lock. */
  private readonly bus: GainNode;
  private readonly keylock: AudioWorkletNode;

  private layers: Layer[] = [];
  private sources: AudioBufferSourceNode[] = [];

  /** Volumen de cada stem: 0 = quitado, 1 = normal. Lo comparten pads y ruedas. */
  private levels: Record<StemName, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };
  /** Último volumen antes de quitarlo con un pad (para devolverlo igual). */
  private lastLevels: Record<StemName, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };

  /** Posición (en segundos de canción) desde la que arrancó el último play. */
  private offset = 0;
  /** Momento del reloj de audio en que arrancó el último play. */
  private startedAt = 0;
  /** Tempo: 1 = normal, 1.05 = +5 %, 0.95 = -5 %. */
  private rate = 1;
  private playing = false;

  /** BPM original de la canción (null si no se ha podido detectar). */
  bpm: number | null = null;

  /** Punto CUE: dónde vuelve la canción al soltar el botón CUE (en segundos). */
  cuePoint = 0;
  /** ¿Está sonando porque mantienes pulsado CUE? */
  private previewing = false;

  /** Cambio de tempo gradual en curso (SYNC), si lo hay. */
  private glideTimer: ReturnType<typeof setInterval> | null = null;

  /** `output` = a dónde mandamos el sonido (normalmente, un canal del mixer). */
  constructor(ctx: AudioContext, output: AudioNode) {
    super();
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.keylock = new AudioWorkletNode(ctx, 'keylock', { outputChannelCount: [2] });
    this.bus.connect(this.keylock).connect(output);
  }

  /** Carga una canción normal (un solo archivo). `bpm`: si ya lo sabemos. */
  async load(data: ArrayBuffer, bpm?: number | null): Promise<void> {
    const buffer = await this.ctx.decodeAudioData(data);
    this.setLayers([{ name: 'main', buffer }], bpm);
  }

  /** Carga una canción separada en stems (los 4 archivos a la vez). */
  async loadStems(files: Record<StemName, ArrayBuffer>, bpm?: number | null): Promise<void> {
    // Descomprimimos los 4 a la vez para que tarde menos.
    const decoded = await Promise.all(
      STEM_NAMES.map(async (name) => ({ name, buffer: await this.ctx.decodeAudioData(files[name]) })),
    );
    this.setLayers(decoded, bpm);
  }

  /** Avisa a quien escuche (la interfaz) de que algo ha cambiado. */
  private emit(type: 'loaded' | 'ended' | 'stems' | 'tempo' | 'transport'): void {
    this.dispatchEvent(new Event(type));
  }

  private setLayers(list: { name: Layer['name']; buffer: AudioBuffer }[], bpm?: number | null): void {
    this.stop();
    for (const layer of this.layers) layer.gain.disconnect();
    this.layers = list.map(({ name, buffer }) => {
      const gain = this.ctx.createGain();
      gain.connect(this.bus);
      return { name, buffer, gain };
    });
    this.levels = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.lastLevels = { ...this.levels };
    this.applyStemLevels();
    this.offset = 0;
    this.cuePoint = 0;
    this.previewing = false;

    // BPM: si nos lo dan (biblioteca), lo usamos; si no, lo calculamos.
    // Con stems, usamos solo la batería: es más fiable.
    const drums = this.layers.find((l) => l.name === 'drums');
    this.bpm = bpm ?? detectBpm(drums ? [drums.buffer] : this.buffers);

    this.emit('loaded');
  }

  get loaded(): boolean {
    return this.layers.length > 0;
  }

  get hasStems(): boolean {
    return this.layers.length > 1;
  }

  /** Los buffers de audio cargados (para dibujar la onda). */
  get buffers(): AudioBuffer[] {
    return this.layers.map((l) => l.buffer);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get duration(): number {
    return Math.max(0, ...this.layers.map((l) => l.buffer.duration));
  }

  /** Posición actual en segundos de canción. */
  get position(): number {
    if (!this.playing) return this.offset;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt) * this.rate;
    return Math.min(this.offset + elapsed, this.duration);
  }

  async play(): Promise<void> {
    if (!this.loaded || this.playing) return;
    // Los navegadores no dejan sonar audio hasta que el usuario hace clic;
    // "resume" desbloquea el sonido tras ese primer clic.
    await this.ctx.resume();
    if (this.offset >= this.duration) this.offset = 0;

    // Todas las capas arrancan EXACTAMENTE en el mismo instante (un pelín en
    // el futuro, para que dé tiempo a programarlas todas). Así no se desfasan.
    const when = this.ctx.currentTime + 0.03;
    const sources = this.layers.map((layer) => {
      const source = this.ctx.createBufferSource();
      source.buffer = layer.buffer;
      source.playbackRate.value = this.rate;
      source.connect(layer.gain);
      source.start(when, this.offset);
      return source;
    });
    sources[0].onended = () => {
      // Solo cuenta como "final" si nadie lo paró a mano.
      if (this.sources !== sources) return;
      this.sources = [];
      this.playing = false;
      this.offset = 0;
      this.emit('ended');
    };

    this.sources = sources;
    this.startedAt = when;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSources();
    this.playing = false;
  }

  async toggle(): Promise<void> {
    // Si pulsas PLAY mientras mantienes CUE, la canción se queda sonando al soltar.
    if (this.previewing) {
      this.previewing = false;
      return;
    }
    if (this.playing) this.pause();
    else await this.play();
  }

  // --- CUE ------------------------------------------------------------------
  //
  // Funciona como en los platos de DJ profesionales:
  //  - Parado en el punto CUE: mientras lo mantienes, suena; al soltar,
  //    vuelve al punto CUE y se para.
  //  - Parado en otro sitio: ese sitio pasa a ser el nuevo punto CUE (y
  //    mientras lo mantienes, suena desde ahí).
  //  - Sonando: vuelve al punto CUE y se para.

  /** Al pulsar CUE. */
  async cueDown(): Promise<void> {
    if (!this.loaded) return;
    if (this.playing && !this.previewing) {
      this.pause();
      this.offset = this.cuePoint;
      this.emit('transport');
      return;
    }
    if (Math.abs(this.position - this.cuePoint) > 0.01) this.cuePoint = this.position;
    this.previewing = true;
    await this.play();
    this.emit('transport');
  }

  /** Al soltar CUE. */
  cueUp(): void {
    if (!this.previewing) return;
    this.previewing = false;
    this.pause();
    this.offset = this.cuePoint;
    this.emit('transport');
  }

  /** Para y vuelve al principio. */
  stop(): void {
    this.stopSources();
    this.playing = false;
    this.offset = 0;
  }

  /** Salta a un segundo concreto de la canción. */
  async seek(seconds: number): Promise<void> {
    const wasPlaying = this.playing;
    this.pause();
    this.offset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) await this.play();
  }

  // --- Tempo ----------------------------------------------------------------

  /** Tempo actual: 1 = normal. */
  get tempo(): number {
    return this.rate;
  }

  /** BPM al que suena ahora mismo (el original × el tempo). */
  get currentBpm(): number | null {
    return this.bpm === null ? null : this.bpm * this.rate;
  }

  /**
   * Cambia el tempo SIN cambiar el tono: el plato va más rápido o más lento
   * y el key lock corrige el tono para que la voz suene igual.
   * Si había un SYNC en marcha, lo cancela (manda el que toca el fader).
   */
  setTempo(rate: number): void {
    this.stopGlide();
    this.applyTempo(rate);
  }

  /**
   * Lleva el tempo hasta `rate` POCO A POCO, en `durationMs` milisegundos.
   * Es lo que usa el botón SYNC: así el cambio no se nota de golpe.
   */
  glideTempo(rate: number, durationMs: number): void {
    this.stopGlide();
    const from = this.rate;
    const start = performance.now();
    this.glideTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      // Curva suave: empieza y acaba despacio, más rápido en el medio.
      const eased = t * t * (3 - 2 * t);
      this.applyTempo(from + (rate - from) * eased);
      if (t >= 1) this.stopGlide();
    }, 30);
    this.emit('tempo');
  }

  get isGliding(): boolean {
    return this.glideTimer !== null;
  }

  private stopGlide(): void {
    if (this.glideTimer === null) return;
    clearInterval(this.glideTimer);
    this.glideTimer = null;
    this.emit('tempo');
  }

  private applyTempo(rate: number): void {
    const now = this.ctx.currentTime;
    if (this.playing) {
      // Guardamos dónde estamos antes de cambiar, para no perder la cuenta.
      this.offset = this.position;
      this.startedAt = Math.max(now, this.startedAt);
      for (const s of this.sources) s.playbackRate.setValueAtTime(rate, this.startedAt);
    }
    this.rate = rate;
    this.keylock.parameters.get('pitch')!.setValueAtTime(1 / rate, now);
    this.emit('tempo');
  }

  // --- Stems ----------------------------------------------------------------

  /** Rueda del mixer: volumen de un grupo (0 = quitado, 1 = normal). */
  setStemGroup(group: StemGroup, level: number): void {
    for (const name of STEM_GROUPS[group]) {
      this.levels[name] = level;
      if (level > 0) this.lastLevels[name] = level;
    }
    this.applyStemLevels();
  }

  /**
   * Lo que marca la rueda de un grupo. Para "Instru" (melodía + bajo) es el
   * mayor de los dos: solo baja a 0 si los dos están quitados.
   */
  groupLevel(group: StemGroup): number {
    return Math.max(...STEM_GROUPS[group].map((n) => this.levels[n]));
  }

  /** Pad: quita un stem, o lo devuelve al volumen que tenía. */
  toggleStem(name: StemName): void {
    this.setStemOn(name, !this.isStemOn(name));
    this.applyStemLevels();
  }

  isStemOn(name: StemName): boolean {
    return this.levels[name] > 0;
  }

  /** Acapella: solo la voz. Si ya estaba en acapella, vuelve todo. */
  acapella(): void {
    this.setOnly(['vocals']);
  }

  /** Instrumental: todo menos la voz. Si ya estaba en instrumental, vuelve todo. */
  instrumental(): void {
    this.setOnly(['other', 'bass', 'drums']);
  }

  /** ¿Está sonando exactamente este conjunto de stems? (para iluminar los botones) */
  isOnly(names: StemName[]): boolean {
    return STEM_NAMES.every((n) => this.isStemOn(n) === names.includes(n));
  }

  private setOnly(names: StemName[]): void {
    const restoreAll = this.isOnly(names);
    for (const n of STEM_NAMES) this.setStemOn(n, restoreAll || names.includes(n));
    this.applyStemLevels();
  }

  private setStemOn(name: StemName, on: boolean): void {
    if (on === this.isStemOn(name)) return;
    if (on) {
      this.levels[name] = this.lastLevels[name] || 1;
    } else {
      this.lastLevels[name] = this.levels[name];
      this.levels[name] = 0;
    }
  }

  private applyStemLevels(): void {
    for (const layer of this.layers) {
      if (layer.name === 'main') continue;
      // Un cambio muy rápido pero suave (10 ms), para que no haga "clic".
      layer.gain.gain.setTargetAtTime(this.levels[layer.name], this.ctx.currentTime, 0.01);
    }
    this.emit('stems');
  }

  private stopSources(): void {
    const sources = this.sources;
    this.sources = []; // así onended sabe que lo paramos nosotros
    for (const s of sources) {
      s.onended = null;
      s.stop();
      s.disconnect();
    }
  }
}
