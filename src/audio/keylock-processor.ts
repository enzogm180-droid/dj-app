/**
 * "Key lock": cambiar la velocidad de una canción SIN cambiar su tono.
 *
 * Truco en dos pasos:
 *  1. El plato reproduce más rápido (por ejemplo, +5 %). Como un vinilo,
 *     eso también sube el tono un 5 %.
 *  2. Este procesador baja el tono exactamente ese 5 % (pitch = 1 / 1,05)
 *     sin tocar la velocidad. Resultado: más rápido, mismo tono.
 *
 * El paso 2 lo hace la librería SoundTouch, que corta el sonido en trocitos
 * de unos 50 ms y los vuelve a pegar con cuidado (técnica "WSOLA").
 *
 * Esto es un "AudioWorklet": un pequeño programa que el navegador ejecuta
 * en un hilo aparte, dedicado solo al audio, y que procesa el sonido en
 * bloques de 128 muestras (~3 ms). Así nunca se corta aunque la pantalla
 * esté ocupada.
 */
import { SoundTouch } from 'soundtouchjs';

// Lo que el navegador ofrece dentro de un AudioWorklet (TypeScript no lo trae de serie).
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BLOCK = 128;

/*
 * BLINDAJE (para que el sonido no se muera al rato):
 *
 *  1. Si SoundTouch da un ERROR, lo atrapamos y empezamos de cero. Sin esto,
 *     un solo error hace que el navegador apague este procesador PARA SIEMPRE
 *     y el plato se queda mudo sin avisar.
 *  2. Si sale un número "roto" (NaN o infinito), lo cambiamos por silencio.
 *     Un NaN que llegue a los filtros del EQ los deja atascados en silencio
 *     hasta recargar la página.
 *  3. Si se acumula demasiado sonido pendiente (pasa al cambiar el tempo poco
 *     a poco, p. ej. con SYNC), tiramos lo que sobra. Si no, el retraso crece
 *     sin parar: ~1 s por hora y cada vez más trabajo para el procesador.
 *
 * Cuando pasa algo de esto, avisamos a la app (para el registro de audio).
 */
class KeylockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  private st = new SoundTouch();
  private readonly input = new Float32Array(BLOCK * 2);
  private readonly output = new Float32Array(BLOCK * 2);
  private prime = 0;
  /** Lo más que dejamos acumular antes de tirar lo que sobra (en muestras por canal). */
  private maxBuffered = 0;
  private pitch = 1;
  private started = false;
  /** Bloques procesados (para avisar del retraso de vez en cuando). */
  private blocks = 0;
  /** Para no inundar la app de avisos: como mucho uno de cada tipo cada 5 s. */
  private lastReport: Record<string, number> = {};

  constructor() {
    super();
    this.reset();
  }

  /** Empieza de cero (al arrancar, o si algo ha ido mal). */
  private reset(): void {
    this.st = new SoundTouch();
    // Trocitos de 50 ms, búsqueda de 15 ms y solape de 8 ms: buena calidad
    // para música con poco retraso.
    this.st.stretch.setParameters(sampleRate, 50, 15, 8);
    this.st.pitch = this.pitch;
    // Antes de empezar a sonar, esperamos a tener un poco de margen guardado
    // para no quedarnos nunca sin sonido entre trocito y trocito.
    this.prime = this.st.stretch.outputChunkSize + BLOCK * 2;
    this.maxBuffered = this.prime + BLOCK * 24; // ~65 ms de margen de más, como mucho
    this.started = false;
  }

  /** Avisa a la app (con calma: uno de cada tipo cada 5 s como mucho). */
  private report(type: string, detail = ''): void {
    const now = currentTime;
    if (now - (this.lastReport[type] ?? -Infinity) < 5) return;
    this.lastReport[type] = now;
    this.port.postMessage({ type, detail });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const [outL, outR] = outputs[0];
    try {
      const pitch = parameters.pitch[0];
      if (pitch !== this.pitch && Number.isFinite(pitch) && pitch > 0) {
        this.pitch = pitch;
        this.st.pitch = pitch;
      }

      // Entrada: izquierda/derecha → intercaladas (L, R, L, R...), como quiere SoundTouch.
      const [left, right = left] = inputs[0] ?? [];
      for (let i = 0; i < BLOCK; i++) {
        this.input[2 * i] = left ? left[i] : 0;
        this.input[2 * i + 1] = right ? right[i] : 0;
      }
      this.st.inputBuffer.putSamples(this.input, 0, BLOCK);
      this.st.process();

      const out = this.st.outputBuffer;
      // 3. ¿Demasiado acumulado? Tiramos lo que sobra (el oído no lo nota: son milisegundos).
      // Dejamos un margen (8 bloques) por encima del mínimo: si recortáramos
      // justo al mínimo, al siguiente bloque podría faltar sonido (microcorte).
      if (out.frameCount > this.maxBuffered) {
        out.receive(out.frameCount - (this.prime + BLOCK * 8));
        this.report('recorte', 'se acumulaba retraso en el key lock');
      }

      // Cada ~90 ms contamos a la app cuánto sonido hay esperando aquí dentro:
      // es un RETRASO (lo que entra ahora sale un poco más tarde). La asistencia
      // de golpe lo usa para cuadrar dos platos que tengan retrasos distintos.
      if (++this.blocks % 32 === 0) this.port.postMessage({ type: 'retraso', detail: String(out.frameCount) });

      // Salida: si hay suficiente sonido procesado, lo sacamos; si no, silencio.
      if (!this.started && out.frameCount >= this.prime) this.started = true;
      if (this.started && out.frameCount >= BLOCK) {
        out.receiveSamples(this.output, BLOCK);
        let broken = false;
        for (let i = 0; i < BLOCK; i++) {
          let l = this.output[2 * i];
          let r = this.output[2 * i + 1];
          // 2. Números rotos → silencio.
          if (!Number.isFinite(l) || !Number.isFinite(r)) {
            broken = true;
            l = 0;
            r = 0;
          }
          outL[i] = l;
          if (outR) outR[i] = r;
        }
        if (broken) {
          this.report('nan', 'el key lock dio números rotos (NaN)');
          this.reset();
        }
      } else {
        this.started = false; // nos hemos quedado sin margen: volvemos a llenarlo
        outL.fill(0);
        outR?.fill(0);
      }
    } catch (err) {
      // 1. Un error NO debe matar el plato: silencio en este bloque y empezar de cero.
      outL.fill(0);
      outR?.fill(0);
      this.report('error', String(err));
      this.reset();
    }
    return true; // seguir vivo
  }
}

registerProcessor('keylock', KeylockProcessor);
