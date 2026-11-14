/**
 * VIGILANTE DEL AUDIO: detecta cuándo deja de sonar, intenta arreglarlo solo
 * y lo apunta todo en un REGISTRO para saber qué pasó.
 *
 * Problema que queremos pillar: "al rato de estar pinchando, deja de sonar".
 * Puede venir de varios sitios, y cada uno se vigila de una forma:
 *
 *  - El navegador "duerme" el audio (AudioContext suspendido o interrumpido,
 *    p. ej. si Windows cambia de tarjeta de sonido) → lo despertamos.
 *  - El reloj del audio se para aunque diga que va → avisamos y lo despertamos.
 *  - Un procesador (key lock) falla → el plato lo reconstruye (ver deck.ts).
 *  - Números rotos (NaN) en la salida → lo apuntamos (los filtros se atascan).
 *  - La app entera se congela (ni pantalla ni teclas) → lo apuntamos al volver.
 *  - Errores del programa → los apuntamos.
 *
 * El registro se guarda en el navegador (sobrevive a recargar la página) y se
 * ve pulsando el indicador "AUDIO" de arriba. Si vuelve a pasar, con eso
 * sabremos exactamente qué fue.
 */

export interface HealthEntry {
  /** Hora, p. ej. "21:34:05". */
  time: string;
  message: string;
}

export type HealthStatus = 'ok' | 'aviso' | 'parado';

const STORAGE_KEY = 'dj-app:registro-audio';
const MAX_ENTRIES = 150;

class AudioHealth extends EventTarget {
  status: HealthStatus = 'ok';
  entries: HealthEntry[] = loadEntries();

  /** Apunta algo en el registro (y en la consola del navegador). */
  log(message: string, status?: HealthStatus): void {
    const time = new Date().toLocaleTimeString('es-ES');
    this.entries.unshift({ time, message });
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // sin almacenamiento: el registro solo vive hasta recargar
    }
    console.warn(`[audio] ${time} ${message}`);
    if (status) this.setStatus(status);
    this.dispatchEvent(new Event('change'));
  }

  setStatus(status: HealthStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new Event('change'));
  }

  clear(): void {
    this.entries = [];
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nada
    }
    this.setStatus('ok');
    this.dispatchEvent(new Event('change'));
  }
}

function loadEntries(): HealthEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

/** El registro de audio de toda la app. */
export const audioHealth = new AudioHealth();

export interface WatchOptions {
  ctx: AudioContext;
  /** Un "medidor" conectado a la salida master (para buscar NaN). */
  analyser: AnalyserNode;
  /** ¿Está sonando algún plato ahora? */
  anyPlaying: () => boolean;
  /** Arreglo a fondo: reconstruir los key lock de los platos. */
  rebuild: () => void;
}

/** Empieza a vigilar. Se llama una vez al arrancar la app. */
export function watchAudio({ ctx, analyser, anyPlaying, rebuild }: WatchOptions): void {
  const wake = (why: string) => {
    audioHealth.log(`${why} → intento reactivarlo`, 'aviso');
    ctx.resume().then(
      () => audioHealth.log('Audio reactivado', 'ok'),
      (err) => audioHealth.log(`No se pudo reactivar el audio: ${err}`, 'parado'),
    );
  };

  // 1. El navegador cambia el estado del audio (lo "duerme", lo interrumpe…).
  ctx.addEventListener('statechange', () => {
    const state = ctx.state as string;
    if (state === 'running') return;
    if (anyPlaying()) wake(`El navegador ha parado el audio (estado: ${state})`);
    else audioHealth.log(`Estado del audio: ${state}`);
  });

  // 2. Cada segundo: ¿avanza el reloj del audio? ¿se ha congelado la app? ¿hay NaN?
  let lastAudioTime = ctx.currentTime;
  let lastWall = performance.now();
  let stuckSeconds = 0;
  let nanReported = false;
  const samples = new Float32Array(analyser.fftSize);
  setInterval(() => {
    const wall = performance.now();
    const gap = (wall - lastWall) / 1000;
    lastWall = wall;
    // La app estuvo congelada (este reloj debería saltar cada 1 s). Si la
    // pestaña está en segundo plano el navegador la frena a propósito: eso no cuenta.
    if (gap > 3 && document.visibilityState === 'visible') {
      audioHealth.log(`La app estuvo congelada ${gap.toFixed(1)} s (ni pantalla ni teclas)`, 'aviso');
    }

    const audioTime = ctx.currentTime;
    const advanced = audioTime - lastAudioTime;
    lastAudioTime = audioTime;
    if (ctx.state === 'running' && anyPlaying() && advanced < 0.2) {
      stuckSeconds++;
      if (stuckSeconds === 2) wake('El reloj del audio se ha parado');
      if (stuckSeconds === 6) {
        audioHealth.log('El audio sigue parado: reconstruyo los key lock', 'parado');
        rebuild();
      }
    } else if (stuckSeconds > 0) {
      if (stuckSeconds >= 2) audioHealth.log(`El reloj del audio vuelve a andar (estuvo parado ${stuckSeconds} s)`, 'ok');
      stuckSeconds = 0;
    } else if (ctx.state !== 'running' && anyPlaying()) {
      wake(`El audio no está en marcha (estado: ${ctx.state})`);
    }

    // Números rotos en la salida: se oyen como silencio total. (Lo apuntamos
    // una vez, no cada segundo.)
    analyser.getFloatTimeDomainData(samples);
    const broken = samples.some((v) => !Number.isFinite(v));
    if (broken && !nanReported) {
      audioHealth.log('Hay números rotos (NaN) en la salida master: pulsa "Reactivar audio"', 'parado');
    }
    nanReported = broken;
  }, 1000);

  // 3. Errores del programa (por si algo falla en silencio).
  window.addEventListener('error', (e) => audioHealth.log(`Error del programa: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => audioHealth.log(`Error del programa: ${String(e.reason)}`));
}
