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
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BLOCK = 128;

class KeylockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  private readonly st = new SoundTouch();
  private readonly input = new Float32Array(BLOCK * 2);
  private readonly output = new Float32Array(BLOCK * 2);
  private readonly prime: number;
  private pitch = 1;
  private started = false;

  constructor() {
    super();
    // Trocitos de 50 ms, búsqueda de 15 ms y solape de 8 ms: buena calidad
    // para música con poco retraso.
    this.st.stretch.setParameters(sampleRate, 50, 15, 8);
    this.st.pitch = 1;
    // Antes de empezar a sonar, esperamos a tener un poco de margen guardado
    // para no quedarnos nunca sin sonido entre trocito y trocito.
    this.prime = this.st.stretch.outputChunkSize + BLOCK * 2;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const pitch = parameters.pitch[0];
    if (pitch !== this.pitch) {
      this.pitch = pitch;
      this.st.pitch = pitch;
    }

    // Entrada: izquierda/derecha → intercaladas (L, R, L, R...), como quiere SoundTouch.
    const [left, right = left] = inputs[0];
    for (let i = 0; i < BLOCK; i++) {
      this.input[2 * i] = left ? left[i] : 0;
      this.input[2 * i + 1] = right ? right[i] : 0;
    }
    this.st.inputBuffer.putSamples(this.input, 0, BLOCK);
    this.st.process();

    // Salida: si hay suficiente sonido procesado, lo sacamos; si no, silencio.
    const out = this.st.outputBuffer;
    const [outL, outR] = outputs[0];
    if (!this.started && out.frameCount >= this.prime) this.started = true;
    if (this.started && out.frameCount >= BLOCK) {
      out.receiveSamples(this.output, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        outL[i] = this.output[2 * i];
        if (outR) outR[i] = this.output[2 * i + 1];
      }
    } else {
      this.started = false; // nos hemos quedado sin margen: volvemos a llenarlo
      outL.fill(0);
      outR?.fill(0);
    }
    return true; // seguir vivo
  }
}

registerProcessor('keylock', KeylockProcessor);
