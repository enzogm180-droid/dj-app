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
import { analyze, type TrackVisual } from './analysis';
import { detectBeats } from './bpm';
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

/** Una palabra de la letra: cuándo empieza (t), cuándo acaba (e) y el texto (w). */
export interface LyricWord {
  t: number;
  e: number;
  w: string;
}

/** Datos extra de una canción que ya conocemos (los guarda el preparador). */
export interface TrackInfo {
  /** Identificador de la canción (para recordar sus hot cues). */
  id?: string | null;
  bpm?: number | null;
  /** Segundo del primer golpe (rejilla de golpes). */
  beat?: number | null;
  lyrics?: LyricWord[] | null;
}

/** Cuántos hot cues tiene cada plato. */
export const HOT_CUES = 4;

/**
 * Los hot cues se guardan en el almacenamiento del navegador, uno por
 * canción. (En la fase 6 irán también a Supabase, para tenerlos en cualquier PC).
 */
function loadHotCues(id: string | null): (number | null)[] {
  const empty = new Array(HOT_CUES).fill(null);
  if (!id) return empty;
  try {
    const saved = JSON.parse(localStorage.getItem(`dj-app:hotcues:${id}`) ?? 'null');
    return Array.isArray(saved) ? empty.map((_, i) => (typeof saved[i] === 'number' ? saved[i] : null)) : empty;
  } catch {
    return empty;
  }
}

function saveHotCues(id: string | null, cues: (number | null)[]): void {
  if (!id) return;
  try {
    if (cues.every((c) => c === null)) localStorage.removeItem(`dj-app:hotcues:${id}`);
    else localStorage.setItem(`dj-app:hotcues:${id}`, JSON.stringify(cues));
  } catch {
    // Si el navegador no deja guardar (modo privado…), simplemente no se recuerdan.
  }
}

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
  /** Segundo del primer golpe: con el BPM forma la "rejilla de golpes". */
  firstBeat: number | null = null;
  /** Análisis para dibujar las ondas (picos de cada stem y booms). */
  visual: TrackVisual | null = null;
  /** Letra palabra a palabra (si la canción está preparada con letra). */
  lyrics: LyricWord[] | null = null;

  /** Punto CUE: dónde vuelve la canción al soltar el botón CUE (en segundos). */
  cuePoint = 0;
  /** ¿Está sonando porque mantienes pulsado CUE? */
  private previewing = false;

  /** Cambio de tempo gradual en curso (SYNC), si lo hay. */
  private glideTimer: ReturnType<typeof setInterval> | null = null;
  /** Empujoncito de tempo en curso para cuadrar los golpes (y el tempo al que volver). */
  private nudge: { timer: ReturnType<typeof setTimeout>; base: number } | null = null;

  /** Loop activo: el trozo [start, end) (en segundos) se repite sin parar. */
  loop: { start: number; end: number } | null = null;
  /** Punto IN marcado, esperando a que pulses OUT. */
  loopIn: number | null = null;

  /** Hot cues: 8 puntos de memoria (en segundos), o null si están vacíos. */
  hotCues: (number | null)[] = new Array(HOT_CUES).fill(null);
  /** Identificador de la canción cargada (para guardar sus hot cues). */
  private trackId: string | null = null;

  /** `output` = a dónde mandamos el sonido (normalmente, un canal del mixer). */
  constructor(ctx: AudioContext, output: AudioNode) {
    super();
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.keylock = new AudioWorkletNode(ctx, 'keylock', { outputChannelCount: [2] });
    this.bus.connect(this.keylock).connect(output);
  }

  /** Carga una canción normal (un solo archivo). `info`: datos que ya sepamos (BPM…). */
  async load(data: ArrayBuffer, info: TrackInfo = {}): Promise<void> {
    const buffer = await this.ctx.decodeAudioData(data);
    this.setLayers([{ name: 'main', buffer }], info);
  }

  /** Carga una canción separada en stems (los 4 archivos a la vez). */
  async loadStems(files: Record<StemName, ArrayBuffer>, info: TrackInfo = {}): Promise<void> {
    // Descomprimimos los 4 a la vez para que tarde menos.
    const decoded = await Promise.all(
      STEM_NAMES.map(async (name) => ({ name, buffer: await this.ctx.decodeAudioData(files[name]) })),
    );
    this.setLayers(decoded, info);
  }

  /** Avisa a quien escuche (la interfaz) de que algo ha cambiado. */
  private emit(type: 'loaded' | 'ended' | 'stems' | 'tempo' | 'transport' | 'loop' | 'hotcues'): void {
    this.dispatchEvent(new Event(type));
  }

  private setLayers(list: { name: Layer['name']; buffer: AudioBuffer }[], info: TrackInfo): void {
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
    this.loop = null;
    this.loopIn = null;
    // Canción nueva, tempo nuevo: vuelve a 0 % para que suene a SU BPM.
    // (Si había un SYNC o un ajuste de golpe a medias, se cancela).
    this.stopGlide();
    this.stopNudge(false);
    this.applyTempo(1);
    this.trackId = info.id ?? null;
    this.hotCues = loadHotCues(this.trackId);

    // Rejilla de golpes (BPM + primer golpe): si nos la da la biblioteca, la
    // usamos; si no, la calculamos. Con stems, solo con la batería: es más fiable.
    const drums = this.layers.find((l) => l.name === 'drums');
    const grid =
      info.bpm != null && info.beat != null
        ? { bpm: info.bpm, firstBeat: info.beat }
        : detectBeats(drums ? [drums.buffer] : this.buffers);
    this.bpm = grid?.bpm ?? null;
    this.firstBeat = grid?.firstBeat ?? null;
    this.visual = analyze(this.layers);
    this.lyrics = info.lyrics ?? null;

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
    return this.positionAt(this.ctx.currentTime);
  }

  /** Dónde estará (o estaba) la canción en un instante del reloj de audio. */
  positionAt(time: number): number {
    if (!this.playing) return this.offset;
    let p = this.offset + Math.max(0, time - this.startedAt) * this.rate;
    // Dentro de un loop, al llegar al final vuelve al principio del loop.
    const loop = this.loop;
    if (loop && p >= loop.end) p = loop.start + ((p - loop.start) % (loop.end - loop.start));
    return Math.min(p, this.duration);
  }

  /**
   * Pone en marcha la canción. `when` = instante exacto del reloj de audio
   * en que debe empezar (si no se da, enseguida).
   */
  async play(when?: number): Promise<void> {
    if (!this.loaded || this.playing) return;
    // Los navegadores no dejan sonar audio hasta que el usuario hace clic;
    // "resume" desbloquea el sonido tras ese primer clic.
    await this.ctx.resume();
    if (this.offset >= this.duration) this.offset = 0;
    const loop = this.loop;
    if (loop && this.offset >= loop.end) this.offset = loop.start;

    // Todas las capas arrancan EXACTAMENTE en el mismo instante (un pelín en
    // el futuro, para que dé tiempo a programarlas todas). Así no se desfasan.
    const start = when ?? this.ctx.currentTime + 0.03;
    const sources = this.layers.map((layer) => {
      const source = this.ctx.createBufferSource();
      source.buffer = layer.buffer;
      source.playbackRate.value = this.rate;
      if (loop) {
        source.loop = true;
        source.loopStart = loop.start;
        source.loopEnd = loop.end;
      }
      source.connect(layer.gain);
      source.start(start, this.offset);
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
    this.startedAt = start;
    this.playing = true;
  }

  // --- Asistencia de golpe ----------------------------------------------------
  //
  // Para que dos canciones vayan "a la vez", sus golpes tienen que caer en el
  // mismo instante. Usamos la rejilla de golpes de cada una (que sigue ahí
  // aunque quites el bajo o la batería con los pads).

  /** Longitud de un golpe en segundos de canción (si no hay BPM, como 120). */
  get beatLength(): number {
    return 60 / (this.bpm ?? 120);
  }

  /** En qué parte del golpe está la canción en `pos`: 0 = justo en el golpe, 0.5 = a mitad. */
  private beatPhase(pos: number): number | null {
    if (this.bpm === null || this.firstBeat === null) return null;
    const beats = (pos - this.firstBeat) / this.beatLength;
    return beats - Math.floor(beats);
  }

  /** El golpe más cercano a `t` (si no hay rejilla, el propio `t`). */
  nearestBeat(t: number): number {
    if (this.firstBeat === null) return t;
    return this.firstBeat + Math.round((t - this.firstBeat) / this.beatLength) * this.beatLength;
  }

  /**
   * Cuántos golpes va "por delante" `master` respecto a este plato en el
   * instante `time` (entre -0,5 y 0,5). 0 = golpes perfectamente cuadrados.
   */
  private beatOffsetTo(master: Deck, time: number, myPos = this.positionAt(time)): number | null {
    const mine = this.beatPhase(myPos);
    const theirs = master.beatPhase(master.positionAt(time));
    if (mine === null || theirs === null) return null;
    const diff = theirs - mine;
    return diff - Math.round(diff);
  }

  /**
   * PLAY con asistencia: arranca de forma que nuestros golpes caigan a la vez
   * que los de `master` (la canción que ya suena).
   *  - Si pulsas un pelín TARDE: arranca ya, pero adelantando la canción lo
   *    justo para que el golpe coincida.
   *  - Si pulsas un pelín PRONTO: espera esa fracción de golpe y arranca justo
   *    en el golpe de la otra.
   */
  async playAlignedTo(master: Deck): Promise<void> {
    if (this.playing) return;
    await this.ctx.resume();
    const when = this.ctx.currentTime + 0.03;
    const diff = master.isPlaying ? this.beatOffsetTo(master, when, this.offset) : null;
    if (diff === null) return this.play();
    if (diff >= 0) {
      this.offset += diff * this.beatLength;
      return this.play(when);
    }
    const masterBeatSeconds = master.beatLength / master.tempo;
    return this.play(when - diff * masterBeatSeconds);
  }

  /**
   * Con las dos sonando: corrige el desfase de golpes acelerando o frenando
   * un poquito (como mucho un 4 %) durante un momento. Así no hay saltos.
   */
  alignPhaseTo(master: Deck): void {
    if (!this.playing || !master.isPlaying) return;
    const diff = this.beatOffsetTo(master, this.ctx.currentTime);
    if (diff === null) return;
    const shift = diff * this.beatLength; // segundos de canción que hay que ganar (o perder)
    if (Math.abs(shift) < 0.003) return;
    const base = this.nudge?.base ?? this.rate;
    this.stopNudge();
    const seconds = Math.max(0.5, Math.abs(shift) / (0.04 * base));
    this.applyTempo(base + shift / seconds);
    this.nudge = {
      base,
      timer: setTimeout(() => {
        this.nudge = null;
        this.applyTempo(base);
      }, seconds * 1000),
    };
  }

  /** Cancela el empujoncito. `restore`: volver al tempo que había antes. */
  private stopNudge(restore = true): void {
    if (!this.nudge) return;
    clearTimeout(this.nudge.timer);
    const base = this.nudge.base;
    this.nudge = null;
    if (restore) this.applyTempo(base);
  }

  // --- Hot cues -------------------------------------------------------------
  //
  //  - Botón vacío: guarda el punto donde estás (ajustado al golpe si `snap`).
  //  - Botón lleno: salta a ese punto. Si está sonando, sigue sonando SIN
  //    perder el ritmo: cae en el mismo momento del golpe en que ibas.

  /** Pulsar un hot cue. */
  hotCue(index: number, snap: boolean): void {
    if (!this.loaded) return;
    const saved = this.hotCues[index];
    if (saved === null) {
      const pos = this.position;
      this.hotCues[index] = Math.max(0, snap ? this.nearestBeat(pos) : pos);
      saveHotCues(this.trackId, this.hotCues);
      this.emit('hotcues');
      return;
    }
    if (!this.playing) {
      // Parado: vamos al punto y lo dejamos como punto CUE.
      this.offset = saved;
      this.cuePoint = saved;
      this.dropLoopIfOutside(saved);
      this.emit('transport');
      return;
    }
    // Sonando: el salto ocurre en un instante concreto (`when`). Calculamos
    // dónde estaremos en ese instante y mantenemos la misma parte del golpe.
    const when = this.ctx.currentTime + 0.03;
    let target = saved;
    const here = this.beatPhase(this.positionAt(when));
    const there = this.beatPhase(saved);
    if (here !== null && there !== null) {
      target = saved + (((here - there) % 1) + 1) % 1 * this.beatLength;
      if (target - saved > this.beatLength * 0.999) target -= this.beatLength; // por redondeos
    }
    this.jumpAt(target, when);
  }

  /** Borra un hot cue. */
  deleteHotCue(index: number): void {
    this.hotCues[index] = null;
    saveHotCues(this.trackId, this.hotCues);
    this.emit('hotcues');
  }

  /**
   * Salta a `target` en el instante `when` SIN hueco de silencio: las fuentes
   * nuevas empiezan justo cuando paran las viejas.
   */
  private jumpAt(target: number, when: number): void {
    const old = this.sources;
    this.sources = [];
    for (const s of old) {
      s.onended = null;
      s.stop(when);
    }
    setTimeout(() => old.forEach((s) => s.disconnect()), 500);
    this.playing = false;
    this.offset = target;
    this.dropLoopIfOutside(target);
    void this.play(when);
  }

  // --- Loops ----------------------------------------------------------------
  //
  // La repetición la hace el propio motor de audio del navegador (loopStart /
  // loopEnd de cada fuente), al instante exacto: sin clics ni huecos y con
  // los 4 stems a la vez.

  /**
   * Loop automático de `beats` golpes desde donde estás.
   * `snap` = true (L.AJUST): empieza en el golpe más cercano.
   * `snap` = false (L.PERS): empieza EXACTAMENTE ahora, haya golpe o no.
   */
  autoLoop(beats: number, snap: boolean): void {
    if (!this.loaded) return;
    const pos = this.position;
    const start = snap ? this.nearestBeat(pos) : pos;
    this.setLoop(Math.max(0, start), start + beats * this.beatLength);
  }

  /** Cambia el tamaño del loop activo (mismo inicio). */
  resizeLoop(beats: number): void {
    if (this.loop) this.setLoop(this.loop.start, this.loop.start + beats * this.beatLength);
  }

  /** Botón IN: marca dónde empezará el loop. */
  markLoopIn(snap: boolean): void {
    if (!this.loaded) return;
    const pos = this.position;
    this.loopIn = snap ? this.nearestBeat(pos) : pos;
    this.emit('loop');
  }

  /** Botón OUT: cierra el loop entre IN y aquí, y empieza a repetirse. */
  markLoopOut(snap: boolean): void {
    const start = this.loopIn ?? this.loop?.start;
    if (start === undefined || start === null) return;
    const pos = this.position;
    let end: number;
    if (snap) {
      // Ajustado: un número entero de golpes (mínimo 1).
      const beats = Math.max(1, Math.round((pos - start) / this.beatLength));
      end = start + beats * this.beatLength;
    } else {
      if (pos - start < 0.05) return; // demasiado corto
      end = pos;
    }
    this.loopIn = null;
    this.setLoop(start, end);
  }

  /** Sale del loop: la canción sigue adelante desde donde esté. */
  exitLoop(): void {
    if (!this.loop) return;
    this.rebase();
    this.loop = null;
    for (const s of this.sources) s.loop = false;
    this.emit('loop');
  }

  private setLoop(start: number, end: number): void {
    end = Math.min(end, this.duration);
    if (end - start < 0.01) return;
    this.rebase();
    // Si ya hemos pasado el final del loop nuevo, volvemos a caer dentro.
    if (this.playing && this.offset >= end) this.offset = start + ((this.offset - start) % (end - start));
    this.loop = { start, end };
    for (const s of this.sources) {
      s.loopStart = start;
      s.loopEnd = end;
      s.loop = true;
    }
    this.emit('loop');
  }

  /** Si saltas fuera del loop (clic en la onda, CUE…), el loop se quita. */
  private dropLoopIfOutside(pos: number): void {
    if (this.loop && (pos < this.loop.start || pos >= this.loop.end)) {
      this.loop = null;
      this.emit('loop');
    }
  }

  /** Apunta "dónde estamos" como nuevo punto de partida (antes de cambiar algo en marcha). */
  private rebase(): void {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.offset = this.positionAt(now);
    this.startedAt = Math.max(now, this.startedAt);
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
      this.dropLoopIfOutside(this.cuePoint);
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
    this.dropLoopIfOutside(this.cuePoint);
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
    this.dropLoopIfOutside(this.offset);
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
    this.stopNudge(false);
    this.applyTempo(rate);
  }

  /**
   * Lleva el tempo hasta `rate` POCO A POCO, en `durationMs` milisegundos.
   * Es lo que usa el botón SYNC: así el cambio no se nota de golpe.
   */
  glideTempo(rate: number, durationMs: number): void {
    this.stopGlide();
    this.stopNudge();
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
      this.rebase();
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
