/**
 * Ayudantes para dibujar ondas con los stems en colores.
 *
 * Cada columna de la onda se pinta "apilando" las capas desde el centro
 * hacia fuera, como una tarta en capas:
 *
 *        voces    (morado)   ← lo más exterior
 *        melodía  (verde)
 *        batería  (gris claro)
 *        bajo     (rojo)     ← lo más cerca del centro
 *   ─────────────────────────  centro
 *        (y lo mismo hacia abajo, como un espejo)
 *
 * El grosor de cada color es lo fuerte que suena esa parte en ese momento,
 * así se ve de un vistazo cuándo entra la voz, cuándo para la batería, etc.
 */
import type { LayerName, TrackVisual } from '../audio/analysis';
import { PEAKS_PER_SECOND } from '../audio/analysis';

/** Orden de las capas, del centro hacia fuera. */
export const LAYER_ORDER: LayerName[] = ['bass', 'drums', 'other', 'vocals'];

/** Colores de cada capa, leídos de las variables CSS (style.css). */
export function layerColors(el: Element): Record<LayerName, string> {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bass: v('--stem-bass'),
    drums: v('--stem-drums'),
    other: v('--stem-other'),
    vocals: v('--stem-vocals'),
    main: v('--wave-main'),
  };
}

/** Las capas que tiene esta canción, en orden de dibujo (centro → fuera). */
export function layersOf(visual: TrackVisual): LayerName[] {
  return visual.peaks.main ? ['main'] : LAYER_ORDER.filter((n) => visual.peaks[n]);
}

/** El valor más alto de `peaks` entre los trocitos i0 (incluido) e i1 (excluido). */
export function peakIn(peaks: Float32Array, i0: number, i1: number): number {
  let max = 0;
  const end = Math.min(i1, peaks.length);
  for (let i = Math.max(0, i0); i < end; i++) if (peaks[i] > max) max = peaks[i];
  return max;
}

/**
 * Calcula, para cada columna de píxeles, cuánto suena cada capa.
 * `timeAt(x)` dice qué segundo de la canción cae en la columna x, y
 * `secondsPerPixel` cuánto tiempo abarca cada columna.
 */
export function columnsFor(
  visual: TrackVisual,
  width: number,
  timeAt: (x: number) => number,
  secondsPerPixel: number,
): { name: LayerName; values: Float32Array }[] {
  return layersOf(visual).map((name) => {
    const peaks = visual.peaks[name]!;
    const values = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const t = timeAt(x);
      const i0 = Math.floor(t * PEAKS_PER_SECOND);
      const i1 = Math.max(i0 + 1, Math.floor((t + secondsPerPixel) * PEAKS_PER_SECOND));
      values[x] = t < 0 ? 0 : peakIn(peaks, i0, i1);
    }
    return { name, values };
  });
}

/** Pinta las columnas apiladas, centradas en `mid`, con altura máxima `half`. */
export function drawStacked(
  g: CanvasRenderingContext2D,
  columns: { name: LayerName; values: Float32Array }[],
  colors: Record<LayerName, string>,
  maxTotal: number,
  mid: number,
  half: number,
): void {
  if (!columns.length) return;
  const width = columns[0].values.length;
  // Sumas acumuladas: cum[k][x] = capas 0..k juntas.
  const cum = columns.map(() => new Float32Array(width));
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let k = 0; k < columns.length; k++) {
      acc += columns[k].values[x];
      cum[k][x] = acc;
    }
  }
  const scale = half / maxTotal;
  // De fuera hacia dentro: cada capa tapa la parte interior de la anterior.
  for (let k = columns.length - 1; k >= 0; k--) {
    g.fillStyle = colors[columns[k].name];
    for (let x = 0; x < width; x++) {
      const h = cum[k][x] * scale;
      if (h > 0.3) g.fillRect(x, mid - h, 1, h * 2);
    }
  }
}
