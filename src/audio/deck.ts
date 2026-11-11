/**
 * Deck = un "plato" de DJ.
 *
 * Se encarga solo del AUDIO: cargar una canción, reproducirla, pausarla,
 * saltar a un punto y cambiar la velocidad (pitch). No sabe nada de botones
 * ni de pantallas; eso lo hace la interfaz (deck-view.ts).
 *
 * Una canción puede cargarse de dos formas:
 *  - NORMAL: un solo archivo (una "capa").
 *  - CON STEMS: cuatro archivos (voces, batería, bajo y melodía), que suenan
 *    a la vez y perfectamente sincronizados. Cada uno tiene su propio volumen,
 *    así que podemos quitar o bajar cualquier parte.
 *
 * Cómo suena (Web Audio API):
 *   capa 1 → volumen capa 1 ┐
 *   capa 2 → volumen capa 2 ├→ ganancia del plato → canal del mixer
 *   ...                     ┘
 *
 * Un AudioBufferSourceNode solo puede arrancarse UNA vez. Por eso, cada vez
 * que pulsamos play creamos fuentes nuevas que empiezan en la posición guardada.
 */

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

interface Layer {
  name: StemName | 'main';
  buffer: AudioBuffer;
  gain: GainNode;
}

export class Deck extends EventTarget {
  private readonly ctx: AudioContext;
  private readonly output: GainNode;

  private layers: Layer[] = [];
  private sources: AudioBufferSourceNode[] = [];

  /** Volumen de cada grupo (ruedas del mixer) y si cada stem está silenciado (pads). */
  private groupLevel: Record<StemGroup, number> = { vocal: 1, instru: 1, beat: 1 };
  private muted: Record<StemName, boolean> = { vocals: false, drums: false, bass: false, other: false };

  /** Posición (en segundos de canción) desde la que arrancó el último play. */
  private offset = 0;
  /** Momento del reloj de audio en que arrancó el último play. */
  private startedAt = 0;
  /** Velocidad: 1 = normal, 1.08 = +8 %, 0.92 = -8 %. */
  private rate = 1;
  private playing = false;

  /** `output` = a dónde mandamos el sonido (normalmente, un canal del mixer). */
  constructor(ctx: AudioContext, output: AudioNode) {
    super();
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.connect(output);
  }

  /** Carga una canción normal (un solo archivo). */
  async load(data: ArrayBuffer): Promise<void> {
    const buffer = await this.ctx.decodeAudioData(data);
    this.setLayers([{ name: 'main', buffer }]);
  }

  /** Carga una canción separada en stems (los 4 archivos a la vez). */
  async loadStems(files: Record<StemName, ArrayBuffer>): Promise<void> {
    // Descomprimimos los 4 a la vez para que tarde menos.
    const decoded = await Promise.all(
      STEM_NAMES.map(async (name) => ({ name, buffer: await this.ctx.decodeAudioData(files[name]) })),
    );
    this.setLayers(decoded);
  }

  /** Avisa a quien escuche (la interfaz) de que algo ha cambiado. */
  private emit(type: 'loaded' | 'ended' | 'stems'): void {
    this.dispatchEvent(new Event(type));
  }

  private setLayers(list: { name: Layer['name']; buffer: AudioBuffer }[]): void {
    this.stop();
    for (const layer of this.layers) layer.gain.disconnect();
    this.layers = list.map(({ name, buffer }) => {
      const gain = this.ctx.createGain();
      gain.connect(this.output);
      return { name, buffer, gain };
    });
    this.muted = { vocals: false, drums: false, bass: false, other: false };
    this.applyStemLevels();
    this.offset = 0;
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
    if (this.playing) this.pause();
    else await this.play();
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

  /**
   * Cambia la velocidad. Ojo: igual que en un vinilo, también cambia el tono
   * (más rápido = más agudo). Mantener el tono ("key lock") vendrá más adelante.
   */
  setRate(rate: number): void {
    if (this.playing) {
      // Guardamos dónde estamos antes de cambiar, para no perder la cuenta.
      this.offset = this.position;
      this.startedAt = Math.max(this.ctx.currentTime, this.startedAt);
      for (const s of this.sources) s.playbackRate.setValueAtTime(rate, this.startedAt);
    }
    this.rate = rate;
  }

  // --- Stems ----------------------------------------------------------------

  /** Rueda del mixer: volumen de un grupo (0 = quitado, 1 = normal). */
  setStemGroup(group: StemGroup, level: number): void {
    this.groupLevel[group] = level;
    this.applyStemLevels();
  }

  /** Pad: quita o vuelve a poner un stem. */
  toggleStemMute(name: StemName): void {
    this.muted[name] = !this.muted[name];
    this.applyStemLevels();
    this.emit('stems');
  }

  isStemMuted(name: StemName): boolean {
    return this.muted[name];
  }

  private applyStemLevels(): void {
    for (const layer of this.layers) {
      if (layer.name === 'main') continue;
      const name = layer.name;
      const group = (Object.keys(STEM_GROUPS) as StemGroup[]).find((g) => STEM_GROUPS[g].includes(name))!;
      const level = this.muted[name] ? 0 : this.groupLevel[group];
      // Un cambio muy rápido pero suave (10 ms), para que no haga "clic".
      layer.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.01);
    }
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
