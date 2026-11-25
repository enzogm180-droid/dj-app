/**
 * "Puente" entre la app y el programa de Windows (Electron).
 *
 * La app (la página) no puede tocar la ventana directamente: está encerrada
 * por seguridad. Aquí le damos SOLO lo que necesita, con un nombre propio:
 *
 *   window.stemzo.cerrar()   → cierra el programa (la X de arriba a la derecha)
 *
 * En Chrome (con `npm run dev`) no existe window.stemzo: así la app sabe que
 * no está dentro del programa y no enseña la X.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stemzo', {
  cerrar: () => ipcRenderer.send('stemzo:cerrar'),
});
