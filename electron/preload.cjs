/**
 * "Puente" entre la app y el programa de Windows (Electron).
 *
 * La app (la página) no puede tocar la ventana ni el disco directamente: está
 * encerrada por seguridad. Aquí le damos SOLO lo que necesita, con un nombre propio:
 *
 *   window.stemzo.cerrar()          → cierra el programa (la X de arriba a la derecha)
 *   window.stemzo.musica.buscar()   → busca "musica separada" en el disco de Stemzo
 *   window.stemzo.musica.listar(…)  → y leer / escribir DENTRO de esa carpeta
 *                                     (lo usa src/library/program-folder.ts)
 *
 * En Chrome (con `npm run dev`) no existe window.stemzo: así la app sabe que
 * no está dentro del programa (no enseña la X y la carpeta se elige a mano).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stemzo', {
  cerrar: () => ipcRenderer.send('stemzo:cerrar'),
  musica: {
    buscar: () => ipcRenderer.invoke('stemzo:musica-buscar'),
    listar: (ruta) => ipcRenderer.invoke('stemzo:musica-listar', ruta),
    tipo: (ruta) => ipcRenderer.invoke('stemzo:musica-tipo', ruta),
    leer: (ruta) => ipcRenderer.invoke('stemzo:musica-leer', ruta),
    crearCarpeta: (ruta) => ipcRenderer.invoke('stemzo:musica-crear-carpeta', ruta),
    escribir: (ruta, datos) => ipcRenderer.invoke('stemzo:musica-escribir', ruta, datos),
  },
});
