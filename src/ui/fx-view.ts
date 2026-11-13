/**
 * La parte VISUAL de los efectos de un plato: 3 filas, una por ranura.
 *
 *   [⏻]  [ Flanger ▾ ]  ───●──────
 *   on    qué efecto     cantidad
 *
 * Doble clic en la cantidad = vuelve al 50 %.
 */
import { FX_LIST, type FxName, type FxRack } from '../audio/fx';

export function createFxView(root: HTMLElement, rack: FxRack, letter: string): void {
  root.classList.add('fx');
  root.setAttribute('aria-label', `Efectos del plato ${letter}`);
  const options = FX_LIST.map(({ name, label }) => `<option value="${name}">${label}</option>`).join('');

  rack.slots.forEach((slot, i) => {
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.innerHTML = `
      <button class="fx-on" aria-pressed="false" aria-label="Encender efecto ${i + 1} del plato ${letter}">FX${i + 1}</button>
      <select aria-label="Efecto ${i + 1} del plato ${letter}">${options}</select>
      <input type="range" min="0" max="1" step="0.01" value="${slot.amount}"
        aria-label="Cantidad del efecto ${i + 1} del plato ${letter}" />
    `;
    const onBtn = row.querySelector('button')!;
    const select = row.querySelector('select')!;
    const amount = row.querySelector('input')!;
    select.value = slot.name;

    onBtn.addEventListener('click', () => {
      slot.setOn(!slot.on);
      onBtn.setAttribute('aria-pressed', String(slot.on));
      row.classList.toggle('on', slot.on);
    });
    select.addEventListener('change', () => slot.setEffect(select.value as FxName));
    amount.addEventListener('input', () => slot.setAmount(Number(amount.value)));
    amount.addEventListener('dblclick', () => {
      amount.value = '0.5';
      slot.setAmount(0.5);
    });
    root.append(row);
  });
}
