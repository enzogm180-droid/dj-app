/**
 * Conexión con la controladora por MIDI (Web MIDI, viene con Chrome y Edge).
 *
 *  1. Pide permiso al navegador para usar dispositivos MIDI.
 *  2. Busca una controladora que conozcamos (por su nombre) y la escucha.
 *  3. Cada mensaje que llega lo busca en el MAPA de esa controladora y mueve
 *     el control de la app que corresponde (src/midi/controls.ts).
 *  4. Al revés: cuando la app enciende una luz (p. ej. PLAY sonando), manda
 *     el mensaje para encenderla en la controladora.
 *
 * Si se desenchufa y se vuelve a enchufar, se reconecta sola.
 */
import { currentLights, onLight, pressControl, setControlValue, turnControl } from './controls';
import { CONTROLLER_MAPS, DDJ_FLX4, type ControllerMap, type MidiBinding } from './ddj-flx4';

/** Un mensaje recibido, para enseñarlo en el monitor MIDI. */
export interface MonitorEntry {
  /** Los 3 números en hexadecimal, p. ej. "90 0B 7F". */
  hex: string;
  /** El control de la app al que ha ido (null = este botón no está en el mapa). */
  control: string | null;
}

export interface MidiStatus {
  /** Nombre de la controladora conectada (null = ninguna). */
  device: string | null;
  /** Mensaje para la pantalla (errores, avisos). */
  message: string;
}

type Listener<T> = (value: T) => void;
const statusListeners = new Set<Listener<MidiStatus>>();
const monitorListeners = new Set<Listener<MonitorEntry>>();

let access: MIDIAccess | null = null;
let input: MIDIInput | null = null;
let output: MIDIOutput | null = null;
let map: ControllerMap = DDJ_FLX4;
let status: MidiStatus = { device: null, message: 'Sin controladora' };

/** Mensaje → binding. Clave "estado:número", p. ej. "176:19" (0xB0 0x13). */
let lookup = new Map<string, { binding: MidiBinding; fine: boolean }>();
/** Últimos valores gruesos (MSB) y finos (LSB) de cada fader de alta precisión. */
const msb = new Map<string, number>();
const lsb = new Map<string, number>();

export function onMidiStatus(listener: Listener<MidiStatus>): void {
  statusListeners.add(listener);
  listener(status);
}

export function onMidiMessage(listener: Listener<MonitorEntry>): void {
  monitorListeners.add(listener);
}

function setStatus(next: MidiStatus): void {
  status = next;
  for (const l of statusListeners) l(status);
}

export function midiSupported(): boolean {
  return 'requestMIDIAccess' in navigator;
}

/** Pide permiso y empieza a escuchar. Se llama al pulsar el botón "MIDI". */
export async function connectMidi(): Promise<void> {
  if (!midiSupported()) {
    setStatus({ device: null, message: 'Este navegador no tiene MIDI. Usa Chrome o Edge.' });
    return;
  }
  if (!access) {
    try {
      access = await navigator.requestMIDIAccess();
    } catch {
      setStatus({ device: null, message: 'Permiso MIDI denegado (mira el candado de la barra de direcciones).' });
      return;
    }
    access.addEventListener('statechange', pickDevice); // enchufar / desenchufar
    onLight(sendLight);
  }
  pickDevice();
}

/** Elige la controladora: primero una que conozcamos; si no, la primera que haya. */
function pickDevice(): void {
  if (!access) return;
  const inputs = [...access.inputs.values()].filter((i) => i.state === 'connected');
  const known = inputs.find((i) => CONTROLLER_MAPS.some((m) => m.match.test(i.name ?? '')));
  const next = known ?? inputs[0] ?? null;
  if (next === input) return;

  if (input) input.onmidimessage = null;
  input = next;
  if (!input) {
    output = null;
    setStatus({ device: null, message: 'No hay ninguna controladora conectada' });
    return;
  }
  map = CONTROLLER_MAPS.find((m) => m.match.test(input!.name ?? '')) ?? DDJ_FLX4;
  buildLookup();
  input.onmidimessage = (e) => handle(e.data);
  // La salida (para las luces) suele llamarse igual que la entrada.
  output = [...access.outputs.values()].find((o) => o.name === input!.name) ?? null;
  setStatus({
    device: input.name ?? 'Controladora',
    message: known ? `Conectada: ${input.name}` : `Conectada: ${input.name} (no la conozco: uso el mapa de la ${map.name})`,
  });
  // Ponemos sus luces como están en la app.
  for (const [id, on] of currentLights()) sendLight(id, on);
}

/**
 * Para PROBAR sin controladora: hace como si la mesa hubiera mandado este
 * mensaje, p. ej. simulateMidi([0x90, 0x0B, 0x7F]) = pulsar PLAY del plato A.
 * (Solo se usa desde la consola del navegador en modo desarrollo.)
 */
export function simulateMidi(bytes: number[]): void {
  if (!lookup.size) buildLookup();
  handle(new Uint8Array(bytes));
}

function buildLookup(): void {
  lookup = new Map();
  for (const binding of map.bindings) {
    lookup.set(`${binding.status}:${binding.data1}`, { binding, fine: false });
    // Faders de alta precisión: el fino llega con el número + 0x20.
    if (binding.kind === 'fader' && binding.data1 < 0x20) {
      lookup.set(`${binding.status}:${binding.data1 + 0x20}`, { binding, fine: true });
    }
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function handle(data: Uint8Array | null): void {
  if (!data || data.length < 3) return;
  let [st, data1, value] = data;
  // "Nota apagada" (0x8_) es lo mismo que soltar un botón: la tratamos como 0x9_ con valor 0.
  if ((st & 0xf0) === 0x80) {
    st = 0x90 | (st & 0x0f);
    value = 0;
  }
  const found = lookup.get(`${st}:${data1}`);
  for (const l of monitorListeners) l({ hex: hex(data), control: found?.binding.control ?? null });
  if (!found) return;

  const { binding, fine } = found;
  switch (binding.kind) {
    case 'button':
      pressControl(binding.control, value > 0);
      break;
    case 'relative':
      turnControl(binding.control, value < 64 ? value : value - 128);
      break;
    case 'jog':
      turnControl(binding.control, value - 64);
      break;
    case 'fader': {
      const key = `${binding.status}:${binding.data1}`;
      if (fine) lsb.set(key, value);
      else msb.set(key, value);
      // 14 bits: grueso × 128 + fino → de 0 a 16383.
      let position = ((msb.get(key) ?? 0) * 128 + (lsb.get(key) ?? 0)) / 16383;
      if (binding.invert) position = 1 - position;
      setControlValue(binding.control, position);
      break;
    }
  }
}

function sendLight(id: string, on: boolean): void {
  if (!output) return;
  for (const light of map.lights[id] ?? []) {
    try {
      output.send([light.status, light.data1, on ? 0x7f : 0x00]);
    } catch {
      // controladora desenchufada justo ahora: no pasa nada
    }
  }
}
