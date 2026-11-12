/**
 * Onda COMPLETA de la canción (la pequeña de cada plato), con:
 *  - los stems en colores (ver stem-draw.ts),
 *  - la parte ya escuchada un poco más oscura,
 *  - una rayita naranja abajo por cada boom (golpe grave),
 *  - la zona del loop, si hay uno, resaltada,
 *  - el punto CUE (línea naranja) y el cabezal (línea blanca).
 *
 * Al hacer clic en ella, la canción salta a ese punto.
 */
import type { TrackVisual } from '../audio/analysis';
import { columnsFor, drawHotCues, drawStacked, layerColors } from './stem-draw';

export class Waveform {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private visual: TrackVisual | null = null;
  /** Columnas ya calculadas (solo cambian al cargar canción o cambiar el tamaño). */
  private columns: ReturnType<typeof columnsFor> = [];

  /** Se llama al hacer clic: recibe la posición de 0 (inicio) a 1 (final). */
  onSeek: ((fraction: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('El navegador no permite dibujar en canvas');
    this.g = g;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.visual) return;
      const rect = canvas.getBoundingClientRect();
      this.onSeek?.((e.clientX - rect.left) / rect.width);
    });

    // Si cambia el tamaño de la ventana, recalculamos para que se vea nítido.
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setVisual(visual: TrackVisual | null): void {
    this.visual = visual;
    this.compute();
  }

  /**
   * Redibuja. `fraction` = cuánto se ha reproducido (0 a 1).
   * `cue` = dónde está el punto CUE (0 a 1), o null si no hay que dibujarlo.
   */
  draw(
    fraction: number,
    cue: number | null = null,
    loop: { start: number; end: number } | null = null,
    hotCues: (number | null)[] = [],
  ): void {
    const { width, height } = this.canvas;
    const g = this.g;
    g.clearRect(0, 0, width, height);
    const visual = this.visual;
    if (!visual) return;

    const ratio = window.devicePixelRatio || 1;
    const css = getComputedStyle(this.canvas);
    const bassStrip = 4 * ratio;
    const waveHeight = height - bassStrip - ratio;
    drawStacked(g, this.columns, layerColors(this.canvas), visual.maxTotal, waveHeight / 2, waveHeight / 2);

    // Booms: una rayita por cada golpe grave, abajo del todo.
    g.fillStyle = css.getPropertyValue('--bass-mark');
    for (const boom of visual.booms) {
      g.globalAlpha = 0.35 + 0.65 * boom.s;
      g.fillRect(Math.floor((boom.t / visual.duration) * width), height - bassStrip, ratio, bassStrip);
    }
    g.globalAlpha = 1;

    // Loop: la zona que se repite, resaltada.
    if (loop) {
      const x0 = (loop.start / visual.duration) * width;
      const x1 = (loop.end / visual.duration) * width;
      g.fillStyle = css.getPropertyValue('--loop');
      g.globalAlpha = 0.3;
      g.fillRect(x0, 0, Math.max(ratio * 2, x1 - x0), waveHeight);
      g.globalAlpha = 1;
    }

    // Lo ya escuchado, más oscuro.
    const playedX = Math.floor(fraction * width);
    g.fillStyle = 'rgba(13, 15, 18, 0.55)';
    g.fillRect(0, 0, playedX, waveHeight);

    if (cue !== null) {
      // Punto CUE: línea naranja con un triangulito arriba.
      const cueX = Math.floor(cue * width);
      g.fillStyle = css.getPropertyValue('--cue');
      g.fillRect(cueX - ratio / 2, 0, ratio, height);
      g.beginPath();
      g.moveTo(cueX - 6 * ratio, 0);
      g.lineTo(cueX + 6 * ratio, 0);
      g.lineTo(cueX, 8 * ratio);
      g.fill();
    }

    // Hot cues: banderitas de colores con su número.
    drawHotCues(g, hotCues, (t) => (t / visual.duration) * width, 0, waveHeight, ratio);

    // Cabezal: la línea que marca por dónde va la canción.
    g.fillStyle = css.getPropertyValue('--playhead');
    g.fillRect(playedX - ratio, 0, 2 * ratio, height);
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.compute();
  }

  private compute(): void {
    const visual = this.visual;
    if (!visual) {
      this.columns = [];
      return;
    }
    const width = this.canvas.width;
    const secondsPerPixel = visual.duration / width;
    this.columns = columnsFor(visual, width, (x) => x * secondsPerPixel, secondsPerPixel);
  }
}
