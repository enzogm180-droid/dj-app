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

// --- TU MÚSICA, SIN TENER QUE ELEGIR LA CARPETA ------------------------------------
//
// Al abrir Stemzo buscamos la carpeta "musica separada" en el MISMO DISCO donde
// está el programa. Así, si llevas Stemzo y la música en el disco Z Slim, la
// encuentra en cualquier portátil aunque Windows le ponga otra letra (D:, E:…).
// Si no está ahí (p. ej. mientras programamos, que Stemzo está en C:), probamos
// D:\musica separada.
//
// La app no puede leer el disco por sí sola (está encerrada por seguridad):
// estas funciones leen y escriben por ella, y SOLO dentro de esa carpeta.

const fs = require('node:fs/promises');

const CARPETA_MUSICA = 'musica separada';

/** La carpeta de música encontrada (la única que dejamos tocar a la app). */
let raizMusica = null;

async function esCarpeta(ruta) {
  try {
    return (await fs.stat(ruta)).isDirectory();
  } catch {
    return false;
  }
}

async function buscarMusica() {
  const discoDelPrograma = path.parse(app.isPackaged ? process.execPath : __dirname).root; // p. ej. "D:\"
  const candidatas = [path.join(discoDelPrograma, CARPETA_MUSICA), path.join('D:\\', CARPETA_MUSICA)];
  for (const ruta of candidatas) {
    if (await esCarpeta(ruta)) {
      raizMusica = ruta;
      return ruta;
    }
  }
  return null;
}

/**
 * Convierte una ruta de la app ("_stems/biblioteca.json") en la ruta real del
 * disco, y comprueba que NO se sale de la carpeta de música.
 */
function rutaSegura(relativa) {
  if (!raizMusica) throw new Error('No hay carpeta de música');
  const ruta = path.resolve(raizMusica, ...String(relativa).split('/').filter(Boolean));
  if (ruta !== raizMusica && !ruta.startsWith(raizMusica + path.sep)) throw new Error('Fuera de la carpeta de música');
  return ruta;
}

ipcMain.handle('stemzo:musica-buscar', () => buscarMusica());

// Qué hay dentro de una carpeta: [{ name, kind: 'file' | 'directory' }]
ipcMain.handle('stemzo:musica-listar', async (_e, rel) => {
  const entradas = await fs.readdir(rutaSegura(rel), { withFileTypes: true });
  return entradas
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }));
});

// ¿Existe? → 'file', 'directory' o null
ipcMain.handle('stemzo:musica-tipo', async (_e, rel) => {
  try {
    const info = await fs.stat(rutaSegura(rel));
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
  } catch {
    return null;
  }
});

// Leer un archivo entero (una canción, un stem, un .json…)
ipcMain.handle('stemzo:musica-leer', async (_e, rel) => {
  const datos = await fs.readFile(rutaSegura(rel));
  return new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength);
});

ipcMain.handle('stemzo:musica-crear-carpeta', async (_e, rel) => {
  await fs.mkdir(rutaSegura(rel), { recursive: true });
});

// Escribir un archivo (tus hot cues en "_stems/mis-datos.json"). Primero en un
// archivo aparte y luego se cambia de golpe: si se desenchufa el disco a medias,
// el archivo viejo sigue bien.
ipcMain.handle('stemzo:musica-escribir', async (_e, rel, datos) => {
  const destino = rutaSegura(rel);
  const temporal = `${destino}.guardando`;
  await fs.writeFile(temporal, typeof datos === 'string' ? datos : Buffer.from(datos));
  await fs.rename(temporal, destino);
});

app.whenReady().then(() => {
  darPermisos();
  servirApp();
  abrirVentana();
});

app.on('window-all-closed', () => app.quit());
