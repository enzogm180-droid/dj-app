/**
 * Rueda (knob) como las de una mesa de mezclas.
 *
 *        ╭───╮
 *      ╱   │   ╲      ← el arco de color marca el valor
 *     │    ●    │
 *      ╲       ╱
 *        ╰───╯
 *
 * Cómo se usa:
 *  - Arrastrar con el ratón hacia ARRIBA sube, hacia ABAJO baja
 *    (con Mayúsculas pulsada, más fino).
 *  - Rueda del ratón encima: sube o baja poco a poco.
 *  - Doble clic: vuelve al valor por defecto (el centro, normalmente).
 *  - Con el teclado (Tab para llegar a ella): flechas, Inicio y Fin.
 *
 * `bipolar` = el arco sale del centro (EQ, filtro, ganancia: lo normal es el
 * centro). Si no, sale desde el mínimo (volumen de un stem: de 0 a 100 %).
 */

export interface KnobOptions {
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  value: number;
  defaultValue: number;
  step: number;
  bipolar?: boolean;
  /**
   * Valor que queda ARRIBA, en el centro de la rueda. Si no se da, es el punto
   * medio entre min y max. Sirve para rangos no simétricos: en el EQ (de -24 a
   * +6 dB) el 0 dB queda arriba; la mitad izquierda va de -24 a 0 y la
   * derecha de 0 a +6.
   */
  center?: number;
  /** Texto que se enseña debajo, p. ej. "+3 dB". */
  format: (value: number) => string;
  /** ¿Se pinta en rojo? (p. ej. una banda quitada del todo, "kill"). */
  isKilled?: (value: number) => boolean;
  onInput: (value: number) => void;
}

export interface Knob {
  readonly el: HTMLElement;
  readonly value: number;
  /** Cambia el valor. `silent` = sin avisar (cuando el cambio viene de fuera). */
  set(value: number, silent?: boolean): void;
  /**
   * Coloca la rueda por su POSICIÓN: 0 = tope izquierdo, 0,5 = arriba (centro),
   * 1 = tope derecho. Es lo que manda una rueda de verdad de la controladora.
   */
  setPosition(position: number): void;
}

const START = -135; // grados: dónde empieza el recorrido (abajo a la izquierda)
const END = 135; // y dónde acaba (abajo a la derecha)
const SIZE = 44;
const R = 17;

/** Punto del círculo en un ángulo (0° = arriba, sentido de las agujas). */
function point(angle: number, radius = R): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [SIZE / 2 + radius * Math.cos(rad), SIZE / 2 + radius * Math.sin(rad)];
}

/** Trazo SVG de un arco entre dos ángulos. */
function arc(from: number, to: number): string {
  if (Math.abs(to - from) < 0.5) return '';
  const [a, b] = from < to ? [from, to] : [to, from];
  const [x1, y1] = point(a);
  const [x2, y2] = point(b);
  return `M ${x1} ${y1} A ${R} ${R} 0 ${b - a > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

export function createKnob(o: KnobOptions): Knob {
  const el = document.createElement('div');
  el.className = 'knob';
  el.innerHTML = `
    <span class="knob-label"></span>
    <div class="knob-dial" tabindex="0" role="slider">
      <svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" aria-hidden="true">
        <circle class="knob-body" cx="${SIZE / 2}" cy="${SIZE / 2}" r="${R - 4}" />
        <path class="knob-track" d="${arc(START, END)}" />
        <path class="knob-value" d="" />
        <line class="knob-pointer" x1="${SIZE / 2}" y1="${SIZE / 2}" x2="${SIZE / 2}" y2="${SIZE / 2 - R + 6}" />
      </svg>
    </div>
    <output class="knob-output"></output>
  `;
  el.querySelector('.knob-label')!.textContent = o.label;
  const dial = el.querySelector<HTMLElement>('.knob-dial')!;
  const valuePath = el.querySelector<SVGPathElement>('.knob-value')!;
  const pointer = el.querySelector<SVGLineElement>('.knob-pointer')!;
  const output = el.querySelector<HTMLOutputElement>('.knob-output')!;
  dial.setAttribute('aria-label', o.ariaLabel);
  dial.setAttribute('aria-valuemin', String(o.min));
  dial.setAttribute('aria-valuemax', String(o.max));

  let value = o.value;

  // "Posición" de la rueda: 0 = tope izquierdo, 0,5 = arriba, 1 = tope derecho.
  // Con `center`, cada mitad de la rueda tiene su propio tramo de valores.
  const center = o.center ?? (o.min + o.max) / 2;
  const posOf = (v: number) =>
    v <= center ? 0.5 * ((v - o.min) / (center - o.min)) : 0.5 + 0.5 * ((v - center) / (o.max - center));
  const valueAt = (p: number) => {
    p = Math.min(1, Math.max(0, p));
    return p <= 0.5 ? o.min + (p / 0.5) * (center - o.min) : center + ((p - 0.5) / 0.5) * (o.max - center);
  };
  const angleOf = (v: number) => START + posOf(v) * (END - START);

  function render(): void {
    const angle = angleOf(value);
    const from = o.bipolar ? angleOf(center) : START;
    valuePath.setAttribute('d', arc(from, angle));
    pointer.setAttribute('transform', `rotate(${angle} ${SIZE / 2} ${SIZE / 2})`);
    const text = o.format(value);
    output.textContent = text;
    dial.setAttribute('aria-valuenow', String(value));
    dial.setAttribute('aria-valuetext', text);
    el.classList.toggle('killed', o.isKilled?.(value) ?? false);
  }

  function set(next: number, silent = false): void {
    const clamped = Math.min(o.max, Math.max(o.min, Math.round(next / o.step) * o.step));
    if (clamped === value && !silent) return;
    value = clamped;
    render();
    if (!silent) o.onInput(value);
  }

  // Arrastrar: 150 píxeles de arriba abajo = todo el recorrido.
  let dragStart: { y: number; pos: number } | null = null;
  dial.addEventListener('pointerdown', (e) => {
    dragStart = { y: e.clientY, pos: posOf(value) };
    try {
      dial.setPointerCapture(e.pointerId);
    } catch {
      // Algunos dispositivos no lo permiten; no pasa nada.
    }
    dial.classList.add('dragging');
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const fine = e.shiftKey ? 0.2 : 1;
    set(valueAt(dragStart.pos + ((dragStart.y - e.clientY) / 150) * fine));
  });

  /** Gira la rueda un trocito (`delta` en posición: 0,05 = un 5 % del recorrido). */
  const nudge = (delta: number) => set(valueAt(posOf(value) + delta));
  const endDrag = () => {
    dragStart = null;
    dial.classList.remove('dragging');
  };
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);

  dial.addEventListener('dblclick', () => set(o.defaultValue));
  dial.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      nudge(e.deltaY < 0 ? 0.025 : -0.025);
    },
    { passive: false },
  );
  dial.addEventListener('keydown', (e) => {
    const actions: Record<string, () => void> = {
      ArrowUp: () => nudge(0.05),
      ArrowRight: () => nudge(0.05),
      ArrowDown: () => nudge(-0.05),
      ArrowLeft: () => nudge(-0.05),
      Home: () => set(o.min),
      End: () => set(o.max),
    };
    if (actions[e.key]) {
      e.preventDefault();
      e.stopPropagation(); // que no active los atajos de los platos
      actions[e.key]();
    }
  });

  render();
  return {
    el,
    get value() {
      return value;
    },
    set,
    setPosition: (position) => set(valueAt(position)),
  };
}
