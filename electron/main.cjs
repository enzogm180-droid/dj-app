/**
 * STEMZO como PROGRAMA DE WINDOWS (Electron).
 *
 * Electron es un Chrome metido dentro de un programa. Este archivo es el
 * "programa principal": abre la ventana y carga dentro nuestra app, la misma
 * que vemos en Chrome con `npm run dev`. La app no sabe que está en Electron.
 *
 * Dos formas de arrancarlo:
 *  - `npm run app`       → compila la app y la abre como programa (como el instalado).
 *  - `npm run app:dev`   → abre la ventana pero cargando el servidor de desarrollo
 *                          (http://localhost:5173): hay que tener `npm run dev` abierto.
 *                          Sirve para ver los cambios al momento mientras programamos.
 *
 * (Es un archivo .cjs: JavaScript "de toda la vida", sin compilar, porque
 * Electron lo lee directamente.)
 */
const { app, BrowserWindow, protocol, net, session, Menu, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEV = process.argv.includes('--dev');
const DEV_URL = 'http://localhost:5173';

// --- Dirección propia de la app: "app://stemzo/" ----------------------------------
// En vez de abrir los archivos con "file://", los servimos con una dirección
// propia. Así el navegador de dentro la trata como una web SEGURA (igual que
// localhost): sin eso no funcionarían el MIDI, elegir la carpeta de música, ni
// se guardarían los hot cues y ajustes entre una vez y otra.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// El sonido puede empezar sin tener que hacer clic antes (en Chrome hace falta).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Solo UN Stemzo abierto a la vez: si lo abres otra vez, se enseña el que ya hay.
if (!app.requestSingleInstanceLock()) app.quit();

/** Los permisos que la app necesita. Como es NUESTRA app, los damos sin preguntar. */
const PERMISOS = new Set([
  'midi', // la controladora (FLX4, Inpulse 500…)
  'midiSysex',
  'media', // ver los nombres de las salidas de sonido (altavoces / cascos)
  'speaker-selection', // elegir por dónde suena cada cosa
  'fileSystem', // leer tu carpeta de música y guardar los hot cues dentro
  'clipboard-sanitized-write',
]);

function darPermisos() {
  session.defaultSession.setPermissionRequestHandler((_web, permiso, responder) => responder(PERMISOS.has(permiso)));
  session.defaultSession.setPermissionCheckHandler((_web, permiso) => PERMISOS.has(permiso));
}

/** Sirve los archivos de la app compilada (carpeta "dist") en app://stemzo/… */
function servirApp() {
  const carpeta = path.join(__dirname, '..', 'dist');
  protocol.handle('app', (request) => {
    let ruta = decodeURIComponent(new URL(request.url).pathname);
    if (ruta === '/' || ruta === '') ruta = '/index.html';
    const archivo = path.normalize(path.join(carpeta, ruta));
    // Seguridad: nunca servimos nada de fuera de la carpeta de la app.
    if (!archivo.startsWith(carpeta)) return new Response('No encontrado', { status: 404 });
    return net.fetch(pathToFileURL(archivo).toString());
  });
}

let ventana = null;

function abrirVentana() {
  ventana = new BrowserWindow({
    title: 'Stemzo',
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#000000', // negro mientras carga (sin destello blanco)
    show: false, // la enseñamos cuando esté lista
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      // El "puente" que deja a la app cerrar el programa (la X de arriba).
      preload: path.join(__dirname, 'preload.cjs'),
      // Que el audio y la mesa NO se ralenticen si la ventana queda detrás de otra.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Sin la barra de menús de arriba (Archivo, Editar…): no la necesitamos.
  Menu.setApplicationMenu(null);

  // Atajos de teclado del programa:
  //   F11              → pantalla completa (para pinchar sin distracciones)
  //   Ctrl + Mayús + I → herramientas de desarrollo (para buscar errores)
  //   Ctrl + R / F5    → recargar
  ventana.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const tecla = input.key.toLowerCase();
    if (tecla === 'f11') {
      ventana.setFullScreen(!ventana.isFullScreen());
      event.preventDefault();
    } else if (input.control && input.shift && tecla === 'i') {
      ventana.webContents.toggleDevTools();
      event.preventDefault();
    } else if (tecla === 'f5' || (input.control && tecla === 'r')) {
      ventana.webContents.reload();
      event.preventDefault();
    }
  });

  // Los enlaces a otras webs no se abren dentro del programa.
  ventana.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Al abrirse, directamente a PANTALLA COMPLETA (sin barra de Windows ni
  // barra de tareas). Para salir: la X de arriba a la derecha, o F11 para
  // volver a una ventana normal.
  ventana.once('ready-to-show', () => {
    ventana.setFullScreen(true);
    ventana.show();
  });

  ventana.loadURL(DEV ? DEV_URL : 'app://stemzo/');
}

app.on('second-instance', () => {
  if (!ventana) return;
  if (ventana.isMinimized()) ventana.restore();
  ventana.focus();
});

// La X de la app pide cerrar el programa (ver preload.cjs).
ipcMain.on('stemzo:cerrar', () => app.quit());

app.whenReady().then(() => {
  darPermisos();
  servirApp();
  abrirVentana();
});

app.on('window-all-closed', () => app.quit());
