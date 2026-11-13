/**
 * Plato tipo vinilo (jog wheel).
 *
 *   - Gira mientras suena, a la velocidad de un disco de 33⅓ rpm (una vuelta
 *     cada 1,8 segundos de canción): la rayita blanca marca el giro.
 *   - El anillo de fuera muestra cuánto se ha escuchado de la canción, y el
 *     puntito naranja dónde está el punto CUE.
 *
 * Con el ratón (o el dedo):
 *   - Canción PARADA: arrastrar en círculo la mueve adelante o atrás, como
 *     girar el disco con la mano para buscar el golpe exacto.
 *   - Canción SONANDO: girar la acelera o la frena un momento (como empujar o
 *     frenar el vinilo con el dedo). Al soltar, vuelve a su tempo.
 */
import type { Deck } from '../audio/deck';

/** Segundos de canción por vuelta (33⅓ vueltas por minuto). */
const SECONDS_PER_TURN = 60 / (100 / 3);
/** Lo más que acelera o frena al girar sonando (±10 %). */
const MAX_BEND = 0.1;

export class Jog {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly deck: Deck;
  private readonly letter: string;
  private touching = false;

  constructor(canvas: HTMLCanvasElement, deck: Deck, letter: string) {
    this.canvas = canvas;
    this.deck = deck;
    this.letter = letter;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('El navegador no permite dibujar en canvas');
    this.g = g;

    new ResizeObserver(() => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      this.draw(); // cambiar el tamaño borra el dibujo: lo repintamos ya
    }).observe(canvas);

    this.setupDrag();
  }

  /** Ángulo (en grados) del puntero respecto al centro del plato. */
  private angleOf(e: PointerEvent): number {
    const r = this.canvas.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  }

  private setupDrag(): void {
    let last: { angle: number; time: number } | null = null;
    let release: ReturnType<typeof setTimeout> | null = null;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.deck.loaded || e.button !== 0) return;
      last = { angle: this.angleOf(e), time: performance.now() };
      this.touching = true;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Algunos dispositivos no lo permiten; no pasa nada.
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const angle = this.angleOf(e);
      const now = performance.now();
      // Cuánto ha girado desde la última vez (entre -180 y 180 grados).
      let delta = angle - last.angle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      const seconds = (now - last.time) / 1000;
      last = { angle, time: now };

      if (!this.deck.isPlaying) {
        // Parado: mover la canción tanto como has girado el disco.
        void this.deck.seek(this.deck.position + (delta / 360) * SECONDS_PER_TURN);
        return;
      }
      // Sonando: cuanto más rápido giras, más acelera (o frena, si giras al revés).
      if (seconds <= 0) return;
      const turnsPerSecond = delta / 360 / seconds;
      const amount = Math.max(-MAX_BEND, Math.min(MAX_BEND, turnsPerSecond * 0.1));
      this.deck.bend(amount);
      // Si dejas el dedo quieto encima, vuelve a su velocidad.
      if (release) clearTimeout(release);
      release = setTimeout(() => this.deck.bend(0), 120);
    });

    const end = () => {
      if (!last) return;
      last = null;
      this.touching = false;
      if (release) clearTimeout(release);
      this.deck.endBend();
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  draw(): void {
    const { width, height } = this.canvas;
    const g = this.g;
    g.clearRect(0, 0, width, height);
    const ratio = window.devicePixelRatio || 1;
    const css = getComputedStyle(this.canvas);
    const cx = width / 2;
    const cy = height / 2;
    const R = Math.min(width, height) / 2 - 2 * ratio;
    const ring = 6 * ratio;
    const disc = R - ring - 3 * ratio;
    const top = -Math.PI / 2;

    // Anillo de fuera: fondo y lo ya escuchado.
    g.lineWidth = ring;
    g.strokeStyle = '#2a2f36';
    g.beginPath();
    g.arc(cx, cy, R - ring / 2, 0, Math.PI * 2);
    g.stroke();
    const duration = this.deck.duration;
    if (duration > 0) {
      g.strokeStyle = css.getPropertyValue('--accent');
      g.beginPath();
      g.arc(cx, cy, R - ring / 2, top, top + (this.deck.position / duration) * Math.PI * 2);
      g.stroke();
      // Punto CUE en el anillo.
      const cueAngle = top + (this.deck.cuePoint / duration) * Math.PI * 2;
      g.fillStyle = css.getPropertyValue('--cue');
      g.beginPath();
      g.arc(cx + Math.cos(cueAngle) * (R - ring / 2), cy + Math.sin(cueAngle) * (R - ring / 2), ring * 0.6, 0, Math.PI * 2);
      g.fill();
    }

    // El disco, con sus surcos.
    g.fillStyle = this.touching ? '#1d2228' : '#15181c';
    g.beginPath();
    g.arc(cx, cy, disc, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = ratio;
    g.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    for (let r = disc * 0.42; r < disc - 2 * ratio; r += 4 * ratio) {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    }

    // La etiqueta del centro.
    const label = disc * 0.36;
    g.fillStyle = this.deck.isPlaying ? css.getPropertyValue('--accent') : '#2a2f36';
    g.beginPath();
    g.arc(cx, cy, label, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = this.deck.isPlaying ? css.getPropertyValue('--bg') : css.getPropertyValue('--muted');
    g.font = `700 ${label * 0.8}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(this.letter, cx, cy + ratio);

    // La rayita que gira con la canción.
    const turn = top + ((this.deck.position / SECONDS_PER_TURN) % 1) * Math.PI * 2;
    g.strokeStyle = css.getPropertyValue('--playhead');
    g.lineWidth = 3 * ratio;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx + Math.cos(turn) * (label + 3 * ratio), cy + Math.sin(turn) * (label + 3 * ratio));
    g.lineTo(cx + Math.cos(turn) * (disc - 3 * ratio), cy + Math.sin(turn) * (disc - 3 * ratio));
    g.stroke();
    g.textAlign = 'start';
  }
}
