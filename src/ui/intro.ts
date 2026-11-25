/**
 * ANIMACIÓN DE INICIO: una línea invisible recorre la pantalla de izquierda a
 * derecha y, a su paso, las cosas se van CREANDO CON UN RESPLANDOR.
 *
 * Son dos partes que van sincronizadas:
 *  1. La MÁSCARA (en style.css, "ANIMACIÓN DE INICIO"): oculta la app y la va
 *     descubriendo de izquierda a derecha, con un borde suave.
 *  2. El RESPLANDOR (aquí): cada botón, rueda, fader, texto… se enciende con un
 *     destello de luz justo cuando la línea pasa por él, y se apaga a su color
 *     normal. Para eso calculamos CUÁNDO llega la línea a cada cosa según su
 *     posición en la pantalla.
 *
 * La app arranca con la clase "intro" (puesta en index.html, para que se vea
 * desde el primer instante). Al terminar la quitamos: así la máscara deja de
 * existir y el navegador no la sigue calculando mientras pinchas.
 */

/**
 * Cuánto tiempo se ve el nombre STEMZO solo, antes de que empiece a pasar la
 * cortina (ms), y cuánto tarda la cortina en cruzar la pantalla (ms).
 */
const DELAY_MS = 1100;
const SWEEP_MS = 2400;
/** Cuánto dura el destello de cada cosa (ms). */
const GLOW_MS = 800;

/** Qué cosas resplandecen al crearse (las "piezas" que se ven, no las cajas grandes). */
const GLOW_SELECTOR = 'h1, button, input, select, canvas, [role="slider"], .lane-letter, th';

/**
 * La curva de velocidad de la línea (la misma "cubic-bezier(0.65, 0, 0.35, 1)"
 * del CSS: arranca despacio, acelera y frena al final). Dado el tiempo (0 a 1)
 * dice cuánto ha avanzado (0 a 1).
 */
function ease(t: number): number {
  // Curva de Bézier con puntos (0,0) (0.65,0) (0.35,1) (1,1): buscamos el punto
  // de la curva cuya X es t, y devolvemos su Y.
  const bx = (u: number) => 3 * 0.65 * u * (1 - u) ** 2 + 3 * 0.35 * u ** 2 * (1 - u) + u ** 3;
  const by = (u: number) => 3 * u ** 2 * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** Lo contrario: para un avance (0 a 1), en qué momento (0 a 1) se alcanza. */
function timeForProgress(progress: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < progress) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Se cumple cuando la animación de inicio ha terminado. Lo pesado del arranque
 * (volver a abrir tu carpeta de música, con sus ~1.300 canciones) espera a esto:
 * mientras el ordenador lee la carpeta, la pantalla no se puede mover y la
 * animación se quedaría CONGELADA en el nombre STEMZO.
 */
let markIntroDone: () => void = () => {};
export const introDone: Promise<void> = new Promise((resolve) => (markIntroDone = resolve));

export function finishIntroWhenDone(app: HTMLElement): void {
  if (!app.classList.contains('intro')) {
    markIntroDone();
    return;
  }
  /** El nombre STEMZO que hay detrás de la cortina (index.html). */
  const logo = document.querySelector<HTMLElement>('.intro-logo');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    app.classList.remove('intro');
    logo?.remove();
    markIntroDone();
    return;
  }
  // Momento en que arranca todo: la máscara y los destellos cuentan desde aquí,
  // así van perfectamente a la vez.
  const start = performance.now();
  const glowing = new WeakSet<Element>();

  // 1. La línea invisible: deslizamos la máscara de "no se ve nada" a "se ve todo".
  const sweepFrames: Keyframe[] = [
    { maskPosition: '100% 0', webkitMaskPosition: '100% 0' },
    { maskPosition: '0 0', webkitMaskPosition: '0 0' },
  ];
  const sweepTiming: KeyframeAnimationOptions = {
    duration: SWEEP_MS,
    delay: DELAY_MS,
    easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    fill: 'forwards',
  };
  const sweep = app.animate(sweepFrames, sweepTiming);
  // El nombre de detrás lleva la máscara al revés y se mueve EXACTAMENTE igual:
  // donde la cortina (la app) aparece, el nombre desaparece.
  logo?.animate(sweepFrames, sweepTiming);

  /** Programa el destello de una cosa para cuando la línea pase por ella. */
  function scheduleGlow(el: Element): void {
    if (glowing.has(el) || !(el instanceof HTMLElement || el instanceof SVGElement)) return;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return; // oculto: no se ve, no brilla
    glowing.add(el);
    // El borde de la máscara va de -25 % a 125 % del ancho de la app (ver style.css).
    const appBox = app.getBoundingClientRect();
    const x = (box.left + box.width / 2 - appBox.left) / appBox.width;
    // +0.1: el destello empieza cuando la cosa ya está casi entera a la vista.
    const progress = Math.min(1, Math.max(0, (x + 0.1 + 0.25) / 1.5));
    const when = start + DELAY_MS + timeForProgress(progress) * SWEEP_MS;
    el.animate(
      [
        { filter: 'brightness(3) drop-shadow(0 0 10px rgba(255, 255, 255, 1))' },
        { filter: 'brightness(1.4) drop-shadow(0 0 4px rgba(255, 255, 255, 0.5))', offset: 0.35 },
        { filter: 'none' },
      ],
      { duration: GLOW_MS, delay: Math.max(0, when - performance.now()), easing: 'ease-out' },
    );
  }

  const scan = (root: ParentNode) => root.querySelectorAll(GLOW_SELECTOR).forEach(scheduleGlow);

  // Las partes de la app se montan en momentos distintos (los platos tardan un
  // poco más): vigilamos lo que va apareciendo mientras dura la animación.
  requestAnimationFrame(() => scan(app));
  const watcher = new MutationObserver((changes) => {
    for (const change of changes) {
      for (const node of change.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(GLOW_SELECTOR)) scheduleGlow(node);
        scan(node);
      }
    }
  });
  watcher.observe(app, { childList: true, subtree: true });

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    watcher.disconnect();
    app.classList.remove('intro');
    logo?.remove(); // el nombre de detrás ya no hace falta
    sweep.cancel(); // ya no hace falta: sin la clase "intro" no hay máscara
    markIntroDone();
  };
  void sweep.finished.then(finish, finish);
  // Por si la animación no llega a ejecutarse:
  setTimeout(finish, DELAY_MS + SWEEP_MS + 1000);
}
