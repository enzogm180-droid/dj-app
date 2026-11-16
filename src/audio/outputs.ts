/**
 * SALIDAS DE AUDIO: por dónde sale el MASTER (altavoces) y por dónde los CASCOS.
 *
 * Tres formas de usar los cascos:
 *
 *  1. "mesa": la controladora tiene su propia tarjeta de sonido con 4 canales
 *     (la DDJ-FLX4, por ejemplo): canales 1-2 = salida MASTER de la mesa
 *     (altavoces) y canales 3-4 = su clavija de AURICULARES.
 *
 *         master ──→ canales 1 y 2 ┐
 *                                  ├─→ la mesa (4 canales)
 *         cascos ──→ canales 3 y 4 ┘
 *
 *  2. "dispositivo": los cascos van a OTRA salida de sonido distinta
 *     (p. ej. la clavija del portátil) y el master a la que elijas.
 *
 *  3. "ninguno": sin cascos; solo suena el master (como antes).
 *
 * La elección se guarda en el navegador y se vuelve a aplicar al abrir la app.
 *
 * Para ver los NOMBRES de las salidas ("Altavoces (DDJ-FLX4)"…), el navegador
 * exige permiso de micrófono (es su regla, aunque no grabamos nada): lo pedimos
 * solo al pulsar "Buscar salidas".
 */
import type { Mixer } from './mixer';
import { audioHealth } from './health';

export type HeadphonesMode = 'ninguno' | 'mesa' | 'dispositivo';

export interface OutputConfig {
  /** Salida para el master ('' = la de Windows por defecto). */
  masterDevice: string;
  headphones: HeadphonesMode;
  /** Salida para los cascos (solo en modo "dispositivo"). */
  headphonesDevice: string;
}

export interface OutputDevice {
  id: string;
  label: string;
}

const STORAGE_KEY = 'dj-app:salidas-audio';
const DEFAULT_CONFIG: OutputConfig = { masterDevice: '', headphones: 'ninguno', headphonesDevice: '' };

/** AudioContext con lo que Chrome/Edge ya traen pero TypeScript aún no conoce. */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

export class AudioOutputs extends EventTarget {
  config: OutputConfig = loadConfig();
  /** Texto para la pantalla: cómo está todo ahora mismo. */
  status = '';
  private readonly ctx: SinkContext;
  private readonly mixer: Mixer;
  /** Para el modo "mesa": junta master y cascos en 4 canales. */
  private merger: ChannelMergerNode | null = null;
  private splitMaster: ChannelSplitterNode | null = null;
  private splitPhones: ChannelSplitterNode | null = null;
  /** Para el modo "dispositivo": los cascos salen por un reproductor aparte. */
  private phonesStream: MediaStreamAudioDestinationNode | null = null;
  private phonesPlayer: SinkAudio | null = null;

  constructor(ctx: AudioContext, mixer: Mixer) {
    super();
    this.ctx = ctx;
    this.mixer = mixer;
  }

  /** ¿Puede el navegador elegir salida? (Chrome y Edge sí) */
  get canChooseDevice(): boolean {
    return typeof this.ctx.setSinkId === 'function';
  }

  /** Cuántos canales tiene la salida del master (4 o más = la mesa puede llevar los cascos). */
  get outputChannels(): number {
    return this.ctx.destination.maxChannelCount;
  }

  /**
   * Lista las salidas de sonido del ordenador. Para ver sus nombres hay que
   * dar permiso (`askPermission`): el navegador lo exige.
   */
  async listDevices(askPermission: boolean): Promise<OutputDevice[]> {
    if (askPermission) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop()); // no grabamos nada: solo era para el permiso
      } catch {
        // sin permiso: saldrán sin nombre ("Salida 1"…)
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || `Salida ${i + 1}` }));
  }

  /** Aplica una configuración (y la guarda). Devuelve el texto de estado. */
  async apply(config: OutputConfig = this.config): Promise<string> {
    this.config = { ...config };
    saveConfig(this.config);
    this.disconnectAll();

    // 1. ¿Por dónde sale el master?
    if (this.canChooseDevice) {
      try {
        await this.ctx.setSinkId!(config.masterDevice);
      } catch (err) {
        audioHealth.log(`No se pudo usar la salida elegida para el master: ${err}`, 'aviso');
      }
    }
    const destination = this.ctx.destination;

    // 2. ¿Y los cascos?
    if (config.headphones === 'mesa' && destination.maxChannelCount >= 4) {
      // 4 canales: master en 1-2, cascos en 3-4.
      destination.channelCount = 4;
      destination.channelCountMode = 'explicit';
      destination.channelInterpretation = 'discrete';
      this.merger = this.ctx.createChannelMerger(4);
      this.splitMaster = this.ctx.createChannelSplitter(2);
      this.splitPhones = this.ctx.createChannelSplitter(2);
      this.mixer.masterOut.connect(this.splitMaster);
      this.mixer.headphonesOut.connect(this.splitPhones);
      this.splitMaster.connect(this.merger, 0, 0);
      this.splitMaster.connect(this.merger, 1, 1);
      this.splitPhones.connect(this.merger, 0, 2);
      this.splitPhones.connect(this.merger, 1, 3);
      this.merger.connect(destination);
      this.status = 'Master por los canales 1-2 de la mesa y cascos por los canales 3-4.';
    } else {
      destination.channelCount = 2;
      destination.channelCountMode = 'explicit';
      destination.channelInterpretation = 'speakers';
      this.mixer.masterOut.connect(destination);
      if (config.headphones === 'mesa') {
        this.status = `Esta salida solo tiene ${destination.maxChannelCount} canales: no puede llevar los cascos. Elige la mesa como salida del master (o los cascos en otra salida).`;
        audioHealth.log('Cascos "en la mesa" no disponibles: la salida elegida no tiene 4 canales', 'aviso');
      } else if (config.headphones === 'dispositivo') {
        this.status = await this.startPhonesPlayer(config.headphonesDevice);
      } else {
        this.status = 'Sin cascos: todo sale por la salida del master.';
      }
    }
    this.dispatchEvent(new Event('change'));
    return this.status;
  }

  /**
   * PITIDO DE PRUEBA: suena un "pi-pi" corto solo por los altavoces (master)
   * o solo por los cascos, para saber qué sale por dónde.
   */
  async testTone(where: 'master' | 'cascos'): Promise<void> {
    await this.ctx.resume();
    const target = where === 'master' ? this.mixer.masterOut : this.mixer.headphonesOut;
    const now = this.ctx.currentTime;
    const tone = this.ctx.createOscillator();
    tone.frequency.value = where === 'master' ? 660 : 880; // tono distinto para cada uno
    const env = this.ctx.createGain();
    env.gain.value = 0;
    // Dos pitidos de 0,15 s.
    for (const start of [0, 0.25]) {
      env.gain.setValueAtTime(0, now + start);
      env.gain.linearRampToValueAtTime(0.25, now + start + 0.01);
      env.gain.setValueAtTime(0.25, now + start + 0.14);
      env.gain.linearRampToValueAtTime(0, now + start + 0.15);
    }
    tone.connect(env).connect(target);
    tone.start(now);
    tone.stop(now + 0.45);
    tone.onended = () => env.disconnect();
  }

  /** Cascos por otra salida: un reproductor aparte que solo lleva la señal de los cascos. */
  private async startPhonesPlayer(deviceId: string): Promise<string> {
    if (!this.phonesStream) this.phonesStream = this.ctx.createMediaStreamDestination();
    this.mixer.headphonesOut.connect(this.phonesStream);
    if (!this.phonesPlayer) {
      this.phonesPlayer = new Audio() as SinkAudio;
      this.phonesPlayer.srcObject = this.phonesStream.stream;
    }
    try {
      if (typeof this.phonesPlayer.setSinkId === 'function') await this.phonesPlayer.setSinkId(deviceId);
      await this.phonesPlayer.play();
      return 'Master por su salida y cascos por la salida elegida.';
    } catch (err) {
      audioHealth.log(`No se pudo usar la salida de los cascos: ${err}`, 'aviso');
      return 'No se pudo usar esa salida para los cascos (¿la has desenchufado?).';
    }
  }

  private disconnectAll(): void {
    try {
      this.mixer.masterOut.disconnect();
    } catch {
      // no estaba conectado
    }
    try {
      this.mixer.headphonesOut.disconnect();
    } catch {
      // no estaba conectado
    }
    this.merger?.disconnect();
    this.splitMaster?.disconnect();
    this.splitPhones?.disconnect();
    this.merger = this.splitMaster = this.splitPhones = null;
    this.phonesPlayer?.pause();
  }
}

function loadConfig(): OutputConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: OutputConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // sin almacenamiento: se elige cada vez
  }
}
