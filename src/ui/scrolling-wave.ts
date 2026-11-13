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
 *   │ ▮ ▮ ▮ ▮ ▮ ▮ ▮ ▮        ▮ ▮ ▮ ▮│▮ ▮ ▮ ▮ ▮ ▮ ▮ │ ← un rectangulito por boom
 *   └──────────────────────────────────────────────┘
 *                                  ↑ ahora
 *
 * Con la rueda del ratón encima se hace zoom (ver más o menos segundos).
 * Haciendo clic y arrastrando a los lados, se mueve la canción.
 */
import type { Deck } from '../audio/deck';
import { columnsFor, drawHotCues, drawStacked, layerColors } from './stem-draw';

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

    // Arrastrar la onda con el ratón para mover la canción, como si movieras
    // el disco con la mano: hacia la izquierda avanza, hacia la derecha retrocede.
    // Mientras arrastras la canción se para; al soltar, si sonaba, sigue sonando.
    let drag: { x: number; position: number; wasPlaying: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!deck.loaded || e.button !== 0) return;
      drag = { x: e.clientX, position: deck.position, wasPlaying: deck.isPlaying };
      deck.pause();
      try {
        canvas.setPointerCapture(e.pointerId); // seguimos aunque el ratón salga de la onda
      } catch {
        // Algunos dispositivos no lo permiten; no pasa nada.
      }
      canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // Píxeles de pantalla → segundos de canción, con el zoom actual.
      const secondsPerPixel = this.seconds / canvas.getBoundingClientRect().width;
      void deck.seek(drag.position - (e.clientX - drag.x) * secondsPerPixel);
    });
    const endDrag = () => {
      if (!drag) return;
      const { wasPlaying } = drag;
      drag = null;
      canvas.classList.remove('dragging');
      if (wasPlaying) this.onResume?.();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  /**
   * Qué hacer al soltar la onda si la canción estaba sonando. Desde fuera le
   * decimos "dale a PLAY" (así, con la asistencia, vuelve a entrar en su golpe).
   */
  onResume: (() => void) | null = null;

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

    // Zonas: letra arriba, onda en medio, booms abajo.
    const lyricsH = 20 * ratio;
    const bassH = 8 * ratio;
    const gap = 3 * ratio;
    const waveTop = lyricsH;
    const waveH = height - lyricsH - bassH - gap;
    const mid = waveTop + waveH / 2;

    // 1. Rejilla de golpes: una rayita en cada golpe (debajo de la onda).
    if (this.deck.bpm !== null && this.deck.firstBeat !== null) {
      const beat = this.deck.beatLength;
      const first = this.deck.firstBeat;
      g.fillStyle = 'rgba(255, 255, 255, 0.12)';
      for (let n = Math.ceil((timeAt(0) - first) / beat); first + n * beat < timeAt(width); n++) {
        g.fillRect(Math.round(xAt(first + n * beat)), waveTop, ratio, waveH);
      }
    }

    // 2. Loop: la zona que se repite, resaltada. Y el punto IN si está marcado.
    const loop = this.deck.loop;
    if (loop) {
      g.fillStyle = css.getPropertyValue('--loop');
      g.globalAlpha = 0.22;
      g.fillRect(xAt(loop.start), waveTop, (loop.end - loop.start) * pxPerSecond, waveH);
      g.globalAlpha = 1;
      g.fillRect(xAt(loop.start) - ratio, waveTop, 2 * ratio, waveH);
      g.fillRect(xAt(loop.end) - ratio, waveTop, 2 * ratio, waveH);
    }
    if (this.deck.loopIn !== null) {
      g.fillStyle = css.getPropertyValue('--loop');
      g.fillRect(xAt(this.deck.loopIn) - ratio, waveTop, 2 * ratio, waveH);
    }

    // 3. Ondas de los stems.
    const columns = columnsFor(visual, width, timeAt, 1 / pxPerSecond);
    drawStacked(g, columns, layerColors(this.canvas), visual.maxTotal, mid, waveH / 2);

    // 4. Booms: un rectangulito por cada golpe grave (más opaco cuanto más fuerte).
    g.fillStyle = css.getPropertyValue('--bass-mark');
    const boomW = Math.max(3 * ratio, 0.04 * pxPerSecond);
    for (const boom of visual.booms) {
      const x = xAt(boom.t);
      if (x < -boomW) continue;
      if (x > width) break;
      g.globalAlpha = 0.35 + 0.65 * boom.s;
      g.fillRect(x, height - bassH, boomW, bassH);
    }
    g.globalAlpha = 1;

    // 5. Lo ya escuchado (a la izquierda del cabezal), más oscuro.
    g.fillStyle = 'rgba(5, 7, 11, 0.5)';
    g.fillRect(0, waveTop, center, waveH);

    // 6. Punto CUE.
    const cueX = xAt(this.deck.cuePoint);
    if (cueX >= 0 && cueX <= width) {
      g.fillStyle = css.getPropertyValue('--cue');
      g.fillRect(cueX - ratio / 2, waveTop, ratio, waveH);
    }

    // 7. Hot cues: banderitas de colores con su número.
    drawHotCues(g, this.deck.hotCues, xAt, waveTop, waveTop + waveH, ratio);

    // 8. Letra: cada palabra en su momento. La que se canta ahora, resaltada.
    this.drawLyrics(position, xAt, lyricsH, ratio, css);

    // 9. Cabezal fijo en el centro, con un halo del color del plato.
    g.save();
    g.shadowColor = css.getPropertyValue('--accent');
    g.shadowBlur = 10 * ratio;
    g.fillStyle = css.getPropertyValue('--playhead');
    g.fillRect(center - ratio, 0, 2 * ratio, height);
    g.restore();
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

    // Etiqueta en la esquina: de dónde sale esta letra.
    //   "internet" = escrita por personas (buscar_letras.py), palabras colocadas sobre la voz.
    //   "IA"       = adivinada por Whisper escuchando el stem de voces.
    const label = this.deck.lyricsSource === 'internet' ? 'letra: internet' : 'letra: IA';
    g.font = `${10 * ratio}px system-ui, sans-serif`;
    const lw = g.measureText(label).width;
    const lx = width - lw - 6 * ratio;
    g.fillStyle = css.getPropertyValue('--bg');
    g.fillRect(lx - 4 * ratio, 2 * ratio, lw + 8 * ratio, lyricsH - 4 * ratio);
    g.fillStyle = css.getPropertyValue('--muted');
    g.fillText(label, lx, y);
  }
}
