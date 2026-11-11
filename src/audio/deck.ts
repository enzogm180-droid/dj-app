/**
 * Deck = un "plato" de DJ.
 *
 * Se encarga solo del AUDIO: cargar una canción, reproducirla, pausarla,
 * saltar a un punto y cambiar la velocidad (pitch). No sabe nada de botones
 * ni de pantallas; eso lo hace la interfaz (main.ts).
 *
 * Cómo suena (Web Audio API):
 *   AudioBufferSourceNode  →  GainNode (ganancia)  →  canal del mixer
 *
 * Un AudioBufferSourceNode solo puede arrancarse UNA vez. Por eso, cada vez
 * que pulsamos play creamos uno nuevo que empieza en la posición guardada.
 */
export class Deck {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  /** Posición (en segundos de canción) desde la que arrancó el último play. */
  private offset = 0;
  /** Momento del reloj de audio en que arrancó el último play. */
  private startedAt = 0;
  /** Velocidad: 1 = normal, 1.08 = +8 %, 0.92 = -8 %. */
  private rate = 1;
  private playing = false;

  /** Se llama cuando la canción llega al final sola. */
  onEnded: (() => void) | null = null;

  /** `output` = a dónde mandamos el sonido (normalmente, un canal del mixer). */
  constructor(ctx: AudioContext, output: AudioNode) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.connect(output);
  }

  /** Lee un archivo de audio del PC y lo convierte en sonido listo para usar. */
  async load(file: File): Promise<AudioBuffer> {
    this.stop();
    const bytes = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(bytes);
    this.offset = 0;
    return this.buffer;
  }

  get loaded(): boolean {
    return this.buffer !== null;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** Posición actual en segundos de canción. */
  get position(): number {
    if (!this.playing) return this.offset;
    const elapsed = (this.ctx.currentTime - this.startedAt) * this.rate;
    return Math.min(this.offset + elapsed, this.duration);
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    // Los navegadores no dejan sonar audio hasta que el usuario hace clic;
    // "resume" desbloquea el sonido tras ese primer clic.
    await this.ctx.resume();
    if (this.offset >= this.duration) this.offset = 0;

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.gain);
    source.onended = () => {
      // Solo cuenta como "final" si nadie lo paró a mano.
      if (this.source !== source) return;
      this.source = null;
      this.playing = false;
      this.offset = 0;
      this.onEnded?.();
    };
    source.start(0, this.offset);

    this.source = source;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSource();
    this.playing = false;
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  /** Para y vuelve al principio. */
  stop(): void {
    this.stopSource();
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
      this.startedAt = this.ctx.currentTime;
      this.source?.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
    }
    this.rate = rate;
  }

  setVolume(volume: number): void {
    this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01);
  }

  private stopSource(): void {
    const source = this.source;
    this.source = null; // así onended sabe que lo paramos nosotros
    source?.stop();
    source?.disconnect();
  }
}
