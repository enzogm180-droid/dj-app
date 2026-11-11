/**
 * Descripción (para TypeScript) de funciones del navegador que permiten abrir
 * una carpeta del PC. Chrome y Edge las tienen, pero TypeScript aún no las
 * incluye de serie, así que las declaramos aquí.
 */
type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandle {
  queryPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
  requestPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker(options?: { id?: string; mode?: FileSystemPermissionMode }): Promise<FileSystemDirectoryHandle>;
}
