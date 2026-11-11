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
  /** Una o varias capas (con stems, son 4 que sumamos para dibujar la onda). */
  private buffers: AudioBuffer[] = [];
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
      if (!this.buffers.length) return;
      const rect = canvas.getBoundingClientRect();
      this.onSeek?.((e.clientX - rect.left) / rect.width);
    });

    // Si cambia el tamaño de la ventana, recalculamos para que se vea nítido.
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setBuffers(buffers: AudioBuffer[]): void {
    this.buffers = buffers;
    this.computePeaks();
  }

  /**
   * Redibuja. `fraction` = cuánto se ha reproducido (0 a 1).
   * `cue` = dónde está el punto CUE (0 a 1), o null si no hay que dibujarlo.
   */
  draw(fraction: number, cue: number | null = null): void {
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

    if (this.buffers.length && cue !== null) {
      // Punto CUE: línea naranja con un triangulito arriba.
      const cueX = Math.floor(cue * width);
      const ratio = window.devicePixelRatio || 1;
      g.fillStyle = css.getPropertyValue('--cue');
      g.fillRect(cueX - ratio / 2, 0, ratio, height);
      g.beginPath();
      g.moveTo(cueX - 6 * ratio, 0);
      g.lineTo(cueX + 6 * ratio, 0);
      g.lineTo(cueX, 8 * ratio);
      g.fill();
    }

    if (this.buffers.length) {
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
    if (!this.buffers.length) return;

    // Para cada canal (izquierdo y derecho), los datos de todas las capas.
    // Con stems, sumamos las 4 capas muestra a muestra: así sale la canción entera.
    const length = Math.min(...this.buffers.map((b) => b.length));
    const channelCount = Math.min(...this.buffers.map((b) => b.numberOfChannels));
    const channels = Array.from({ length: channelCount }, (_, c) => this.buffers.map((b) => b.getChannelData(c)));
    const samplesPerColumn = Math.max(1, Math.floor(length / columns));

    for (let x = 0; x < columns; x++) {
      let min = 0;
      let max = 0;
      const start = x * samplesPerColumn;
      const end = Math.min(start + samplesPerColumn, length);
      for (const layers of channels) {
        for (let i = start; i < end; i++) {
          let v = 0;
          for (const data of layers) v += data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      this.peaks[x * 2] = min;
      this.peaks[x * 2 + 1] = max;
    }
  }
}
