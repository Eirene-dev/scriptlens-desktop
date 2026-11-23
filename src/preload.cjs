// The lab page's bridge: window.scriptlensNative — the app's version, a video's caption tracks, a track's captions.
// Nothing else. Exposed only on the lab's origin; the main process checks again (main frame, /scriptlens, this window).
// Sandboxed: CommonJS, and only the 'electron' module's renderer parts.

const { contextBridge, ipcRenderer } = require('electron');

function arg(name) {
  const prefix = `--${name}=`;
  const a = (process.argv || []).find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
}

const allowedOrigin = arg('scriptlens-origin');
const appVersion = arg('scriptlens-app-version');

if (allowedOrigin && location.origin === allowedOrigin) {
  contextBridge.exposeInMainWorld(
    'scriptlensNative',
    Object.freeze({
      appVersion,
      listTracks: (videoId) => ipcRenderer.invoke('scriptlens:listTracks', String(videoId)),
      getTranscript: (videoId, track) =>
        ipcRenderer.invoke('scriptlens:getTranscript', String(videoId), {
          language_code: String(track && track.language_code),
          is_generated: !!(track && track.is_generated === true),
        }),
    }),
  );
}
