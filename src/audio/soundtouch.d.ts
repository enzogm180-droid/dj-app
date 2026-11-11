/**
 * Descripción (para TypeScript) de la parte de la librería SoundTouch que
 * usamos. La librería está escrita en JavaScript y no trae esta descripción.
 */
declare module 'soundtouchjs' {
  export class FifoSampleBuffer {
    readonly frameCount: number;
    putSamples(samples: Float32Array, position?: number, numFrames?: number): void;
    receiveSamples(output: Float32Array, numFrames?: number): void;
  }

  export class Stretch {
    readonly outputChunkSize: number;
    setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
  }

  export class SoundTouch {
    stretch: Stretch;
    pitch: number;
    tempo: number;
    readonly inputBuffer: FifoSampleBuffer;
    readonly outputBuffer: FifoSampleBuffer;
    process(): void;
  }
}
