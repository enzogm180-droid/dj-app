/**
 * Dibuja la forma de onda de una canción en un <canvas>.
 *
 * Idea: dividimos la canción en tantos trozos como píxeles de ancho tenga el
 * canvas, y de cada trozo guardamos el pico más alto y el más bajo. Luego
 * dibujamos una barra vertical por píxel entre esos dos picos.
 */
export class Waveform {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private buffer: AudioBuffer | null = null;
  /** Para cada columna de píxeles: [mínimo, máximo] entre -1 y 1. */
  private peaks: Float32Array = new Float32Array(0);

  /** Se llama al hacer clic: recibe la posición de 0 (inicio) a 1 (final). */
  onSeek: ((fraction: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('El navegador no permite dibujar en canvas');
    this.g = g;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.buffer) return;
      const rect = canvas.getBoundingClientRect();
      this.onSeek?.((e.clientX - rect.left) / rect.width);
    });

    // Si cambia el tamaño de la ventana, recalculamos para que se vea nítido.
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.computePeaks();
  }

  /** Redibuja. `fraction` = cuánto se ha reproducido (0 a 1). */
  draw(fraction: number): void {
    const { width, height } = this.canvas;
    const g = this.g;
    const css = getComputedStyle(this.canvas);
    g.clearRect(0, 0, width, height);

    const mid = height / 2;
    const playedX = Math.floor(fraction * width);
    const columns = this.peaks.length / 2;

    for (let x = 0; x < columns; x++) {
      const min = this.peaks[x * 2];
      const max = this.peaks[x * 2 + 1];
      g.fillStyle = x < playedX ? css.getPropertyValue('--wave-played') : css.getPropertyValue('--wave');
      const top = mid - max * mid;
      const h = Math.max(1, (max - min) * mid);
      g.fillRect(x, top, 1, h);
    }

    if (this.buffer) {
      // Cabezal: la línea que marca por dónde va la canción.
      g.fillStyle = css.getPropertyValue('--playhead');
      g.fillRect(playedX - 1, 0, 2, height);
    }
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.computePeaks();
  }

  private computePeaks(): void {
    const columns = this.canvas.width;
    this.peaks = new Float32Array(columns * 2);
    if (!this.buffer) return;

    // Mezclamos los canales (izquierdo y derecho) mirando todos a la vez.
    const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, i) =>
      this.buffer!.getChannelData(i),
    );
    const samplesPerColumn = Math.max(1, Math.floor(this.buffer.length / columns));

    for (let x = 0; x < columns; x++) {
      let min = 0;
      let max = 0;
      const start = x * samplesPerColumn;
      const end = Math.min(start + samplesPerColumn, this.buffer.length);
      for (const data of channels) {
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      this.peaks[x * 2] = min;
      this.peaks[x * 2 + 1] = max;
    }
  }
}
