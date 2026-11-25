/**
 * Configuración de Vite (el servidor de `npm run dev` y el que compila la app).
 *
 * Solo cambiamos una cosa: que NO vigile la carpeta "release", donde se crea
 * el instalador de Stemzo (`npm run app:instalador`). Si la vigila, al crear
 * el instalador ve miles de archivos nuevos, se bloquea con alguno y el
 * `npm run dev` se cierra solo.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      ignored: ['**/release/**'],
    },
  },
});
