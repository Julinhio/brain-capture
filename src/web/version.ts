declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export const APP_VERSION = __APP_VERSION__;

/** e.g. "Version 3dc1001 · built 2 Nov, 14:05" */
export function versionLabel(): string {
  const built = new Date(__BUILD_TIME__).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Version ${APP_VERSION} · built ${built}`;
}
