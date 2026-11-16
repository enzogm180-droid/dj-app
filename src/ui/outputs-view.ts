/**
 * Botón "🔊 Salidas" de la barra de arriba y su panel: elegir POR DÓNDE SALE
 * el sonido de la mesa (altavoces) y el de los AURICULARES.
 *
 *   🔊 Sonido de la mesa / altavoces:  [ DDJ-FLX4            ▾ ]  [Probar]
 *   🎧 Auriculares:                    [ En la mesa (3-4)    ▾ ]  [Probar]
 *
 * "Probar" suena un pitido corto solo por esa salida, para saber cuál es cuál.
 */
import type { AudioOutputs, HeadphonesMode, OutputDevice } from '../audio/outputs';

export function createOutputsView(button: HTMLButtonElement, panel: HTMLElement, outputs: AudioOutputs): void {
  panel.classList.add('outputs-panel');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="outputs-row">
      <span class="outputs-label">🔊 Sonido de la mesa / altavoces</span>
      <select data-el="master-device" aria-label="Salida de los altavoces (master)"></select>
      <button class="small" data-el="test-master" title="Suena un pitido solo por los altavoces">Probar</button>
    </div>
    <div class="outputs-row">
      <span class="outputs-label">🎧 Auriculares</span>
      <select data-el="phones" aria-label="Salida de los auriculares"></select>
      <button class="small" data-el="test-phones" title="Suena un pitido solo por los auriculares">Probar</button>
    </div>
    <div class="outputs-row outputs-foot">
      <button class="small" data-el="scan">Ver mis salidas de sonido</button>
      <span class="muted-text" data-el="hint"></span>
    </div>
    <p class="outputs-warning" data-el="warning" hidden>
      <span data-el="warning-text"></span>
      <button class="small" data-el="use-controller" hidden></button>
    </p>
    <p class="outputs-status" data-el="status"></p>
  `;
  const masterSelect = panel.querySelector<HTMLSelectElement>('[data-el="master-device"]')!;
  const phonesSelect = panel.querySelector<HTMLSelectElement>('[data-el="phones"]')!;
  const statusEl = panel.querySelector<HTMLElement>('[data-el="status"]')!;
  const hint = panel.querySelector<HTMLElement>('[data-el="hint"]')!;
  const warning = panel.querySelector<HTMLElement>('[data-el="warning"]')!;
  const warningText = panel.querySelector<HTMLElement>('[data-el="warning-text"]')!;
  const useControllerBtn = panel.querySelector<HTMLButtonElement>('[data-el="use-controller"]')!;
  let devices: OutputDevice[] = [];
  let controllerId = '';

  /** Nombre real de la salida "por defecto" de Windows (p. ej. "Altavoces (Realtek)"). */
  function defaultName(): string {
    const label = devices.find((d) => d.id === '')?.label ?? '';
    return label.replace(/^(predeterminado|default)\s*-\s*/i, '');
  }

  /** ¿Son la misma tarjeta de sonido? (comparando nombres, que es lo que sabemos) */
  const same = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

  /**
   * AVISOS para que no te pase lo de "todo suena por el portátil":
   *  - altavoces y auriculares por la MISMA salida → se oye todo junto;
   *  - hay una controladora enchufada pero los altavoces no van por ella.
   */
  function checkWarnings(): void {
    const { masterDevice, headphones, headphonesDevice } = outputs.config;
    const masterName = masterDevice ? (devices.find((d) => d.id === masterDevice)?.label ?? '') : defaultName();
    const phonesName = headphones === 'dispositivo' ? (devices.find((d) => d.id === headphonesDevice)?.label ?? '') : '';
    const controller = devices.find((d) => d.id && /ddj|flx|pioneer|inpulse|hercules|numark|traktor|rane/i.test(d.label));
    controllerId = controller?.id ?? '';

    const messages: string[] = [];
    if (headphones === 'dispositivo' && same(masterName, phonesName)) {
      messages.push(`⚠ Altavoces y auriculares salen por el MISMO sitio (${phonesName}): el público oiría lo que pre-escuchas.`);
    }
    const masterIsController = controller && same(masterName, controller.label);
    if (controller && !masterIsController) {
      messages.push(`⚠ Tienes la controladora enchufada, pero los altavoces suenan por "${masterName || 'otra salida'}".`);
      useControllerBtn.textContent = `Usar "${controller.label}" para los altavoces`;
    }
    useControllerBtn.hidden = !controller || !!masterIsController;
    warningText.textContent = messages.join(' ');
    warning.hidden = messages.length === 0;
  }

  function fill(): void {
    const { masterDevice, headphones, headphonesDevice } = outputs.config;
    const named = devices.filter((d) => d.id); // la "por defecto" ya va como primera opción
    const winName = defaultName();
    masterSelect.replaceChildren(
      option('', winName ? `La de Windows: ${winName}` : 'La de Windows (por defecto)', masterDevice === ''),
      ...named.map((d) => option(d.id, d.label, d.id === masterDevice)),
    );
    phonesSelect.replaceChildren(
      option('ninguno', 'No usar auriculares', headphones === 'ninguno'),
      option('mesa', 'En la mesa (clavija de auriculares de la controladora)', headphones === 'mesa'),
      ...named.map((d) =>
        option(`dispositivo:${d.id}`, d.label, headphones === 'dispositivo' && d.id === headphonesDevice),
      ),
    );
    masterSelect.disabled = !outputs.canChooseDevice;
    // Si no sabemos los nombres, explicamos por qué hay que pulsar el botón.
    hint.textContent = named.length
      ? `${named.length} salida(s) encontrada(s).`
      : 'Pulsa el botón para ver la lista (el navegador pedirá permiso de micrófono solo para saber los nombres; no se graba nada).';
    statusEl.textContent = outputs.status;
    button.title = outputs.status;
    checkWarnings();
  }

  async function apply(): Promise<void> {
    const value = phonesSelect.value;
    const headphones: HeadphonesMode = value.startsWith('dispositivo:') ? 'dispositivo' : (value as HeadphonesMode);
    statusEl.textContent = 'Aplicando…';
    await outputs.apply({
      masterDevice: masterSelect.value,
      headphones,
      headphonesDevice: headphones === 'dispositivo' ? value.slice('dispositivo:'.length) : '',
    });
    fill();
  }

  async function scan(askPermission: boolean): Promise<void> {
    try {
      devices = await outputs.listDevices(askPermission);
    } catch {
      devices = [];
    }
    fill();
  }

  // Botón del aviso: pone la controladora como salida de los altavoces de un clic.
  useControllerBtn.addEventListener('click', () => {
    masterSelect.value = controllerId;
    void apply();
  });
  masterSelect.addEventListener('change', () => void apply());
  phonesSelect.addEventListener('change', () => void apply());
  panel.querySelector('[data-el="scan"]')!.addEventListener('click', () => void scan(true));
  panel.querySelector('[data-el="test-master"]')!.addEventListener('click', () => void outputs.testTone('master'));
  panel.querySelector('[data-el="test-phones"]')!.addEventListener('click', () => void outputs.testTone('cascos'));
  outputs.addEventListener('change', fill);
  // Si enchufas o desenchufas algo (la mesa, unos cascos USB…), la lista se actualiza sola.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void scan(false));

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) void scan(false);
  });
  void scan(false); // sin pedir permiso: si ya lo diste otra vez, salen los nombres
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}
