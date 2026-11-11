/**
 * Onda que AVANZA con la canción (la grande de arriba).
 *
 * En vez de enseñar la canción entera, enseña solo unos segundos alrededor
 * del momento actual, con el cabezal fijo en el centro: la onda "pasa" por
 * debajo según suena la canción, como en los programas de DJ.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ letra   y   que   se   va      │   cantando   │ ← palabras en su momento
 *   │ ▁▃▅▇█▇▅▃▁▃▅▇█▇▅▃▁▃▅▇█▇▅▃▁▃▅▇█▇│▅▃▁▃▅▇█▇▅▃▁▃▅ │ ← stems en colores
 *   │ ████████████████       ███████│█████████████ │ ← tramos de bajo
 *   └──────────────────────────────────────────────┘
 *                                  ↑ ahora
 *
 * Con la rueda del ratón encima se hace zoom (ver más o menos segundos).
 */
import type { Deck } from '../audio/deck';
import { columnsFor, drawStacked, layerColors } from './stem-draw';

const MIN_SECONDS = 4;
const MAX_SECONDS = 40;

export class ScrollingWave {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly deck: Deck;
  /** Cuántos segundos caben a lo ancho. */
  private seconds = 12;

  constructor(canvas: HTMLCanvasElement, deck: Deck) {
    this.canvas = canvas;
    this.deck = deck;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('El navegador no permite dibujar en canvas');
    this.g = g;

    new ResizeObserver(() => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
    }).observe(canvas);

    // Zoom con la rueda del ratón.
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        this.seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, this.seconds * factor));
      },
      { passive: false },
    );
  }

  draw(): void {
    const { width, height } = this.canvas;
    const g = this.g;
    g.clearRect(0, 0, width, height);
    const visual = this.deck.visual;
    const ratio = window.devicePixelRatio || 1;
    const css = getComputedStyle(this.canvas);
    const center = Math.floor(width / 2);

    if (!visual) {
      g.fillStyle = css.getPropertyValue('--muted');
      g.font = `${12 * ratio}px system-ui, sans-serif`;
      g.fillText('Sin canción', 12 * ratio, height / 2);
      return;
    }

    const position = this.deck.position;
    const pxPerSecond = width / this.seconds;
    const timeAt = (x: number) => position + (x - center) / pxPerSecond;
    const xAt = (t: number) => center + (t - position) * pxPerSecond;

    // Zonas: letra arriba, onda en medio, tramos de bajo abajo.
    const lyricsH = 20 * ratio;
    const bassH = 6 * ratio;
    const gap = 3 * ratio;
    const waveTop = lyricsH;
    const waveH = height - lyricsH - bassH - gap;
    const mid = waveTop + waveH / 2;

    // 1. Ondas de los stems.
    const columns = columnsFor(visual, width, timeAt, 1 / pxPerSecond);
    drawStacked(g, columns, layerColors(this.canvas), visual.maxTotal, mid, waveH / 2);

    // 2. Tramos de bajo.
    g.fillStyle = css.getPropertyValue('--bass-mark');
    for (const [a, b] of visual.bass) {
      const x0 = xAt(a);
      const x1 = xAt(b);
      if (x1 < 0 || x0 > width) continue;
      g.fillRect(x0, height - bassH, x1 - x0, bassH);
    }

    // 3. Lo ya escuchado (a la izquierda del cabezal), más oscuro.
    g.fillStyle = 'rgba(13, 15, 18, 0.45)';
    g.fillRect(0, waveTop, center, waveH);

    // 4. Punto CUE.
    const cueX = xAt(this.deck.cuePoint);
    if (cueX >= 0 && cueX <= width) {
      g.fillStyle = css.getPropertyValue('--cue');
      g.fillRect(cueX - ratio / 2, waveTop, ratio, waveH);
    }

    // 5. Letra: cada palabra en su momento. La que se canta ahora, resaltada.
    this.drawLyrics(position, xAt, lyricsH, ratio, css);

    // 6. Cabezal fijo en el centro.
    g.fillStyle = css.getPropertyValue('--playhead');
    g.fillRect(center - ratio, 0, 2 * ratio, height);
  }

  private drawLyrics(
    position: number,
    xAt: (t: number) => number,
    lyricsH: number,
    ratio: number,
    css: CSSStyleDeclaration,
  ): void {
    const words = this.deck.lyrics;
    if (!words?.length) return;
    const g = this.g;
    const width = this.canvas.width;
    g.font = `600 ${12 * ratio}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    const y = lyricsH / 2;
    let lastRight = -Infinity;

    for (const word of words) {
      const x = xAt(word.t);
      if (x > width) break;
      const w = g.measureText(word.w).width;
      if (x + w < 0) continue;
      const current = word.t <= position && position < word.e + 0.15;
      // Si se pisa con la anterior, nos la saltamos (salvo la que suena ahora).
      if (x < lastRight + 4 * ratio && !current) continue;
      if (current) {
        g.fillStyle = css.getPropertyValue('--stem-vocals');
        g.fillRect(x - 3 * ratio, 2 * ratio, w + 6 * ratio, lyricsH - 4 * ratio);
        g.fillStyle = css.getPropertyValue('--bg');
      } else {
        g.fillStyle = word.t < position ? css.getPropertyValue('--muted') : css.getPropertyValue('--text');
      }
      g.fillText(word.w, x, y);
      lastRight = x + w;
    }
  }
}
