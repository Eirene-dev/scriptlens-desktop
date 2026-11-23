/**
 * Electron's fuses in a built Mac app, read and written in place — no dependency. The same approach as praxis-desktop's
 * scripts/electron-fuses.ts. The fuses are one "wire" in the Electron Framework binary: a fixed sentinel, the wire's
 * version (1), its length, then one byte per fuse — '0' off, '1' on, 'r' removed. Version 1's order:
 *
 *   0 RunAsNode   1 EnableCookieEncryption   2 EnableNodeOptionsEnvironmentVariable   3 EnableNodeCliInspectArguments
 *   4 EnableEmbeddedAsarIntegrityValidation   5 OnlyLoadAppFromAsar   6 LoadBrowserProcessSpecificV8Snapshot
 *   7 GrantFileProtocolExtraPrivileges   8 WasmTrapHandlers
 *
 * The distributed build turns 0, 2 and 3 off: no other process can run the app's binary as Node, hand it code through
 * the environment, or attach a debugger to its main process. Writing the binary breaks its signature: sign afterwards.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
export const NODE_FUSES = { RunAsNode: 0, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3 };

export const frameworkOf = (app) => join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');

export function readFuses(app) {
  const bytes = readFileSync(frameworkOf(app));
  const marker = Buffer.from(FUSE_SENTINEL, 'latin1');
  const out = [];
  for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + 1)) {
    const version = bytes[at + marker.length];
    const length = bytes[at + marker.length + 1];
    out.push({ version, wire: bytes.subarray(at + marker.length + 2, at + marker.length + 2 + length).toString('latin1') });
  }
  return out;
}

export const nodeFusesClosed = (app) => {
  const wires = readFuses(app);
  return wires.length > 0 && wires.every((w) => w.version === 1 && Object.values(NODE_FUSES).every((i) => w.wire[i] === '0'));
};

export function closeNodeFuses(app) {
  const file = frameworkOf(app);
  const bytes = readFileSync(file);
  const marker = Buffer.from(FUSE_SENTINEL, 'latin1');
  const written = [];
  for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + 1)) {
    if (bytes[at + marker.length] !== 1) throw new Error(`fuse wire version ${bytes[at + marker.length]} — this script knows version 1`);
    const length = bytes[at + marker.length + 1];
    for (const i of Object.values(NODE_FUSES)) {
      if (i >= length) throw new Error(`fuse ${i} is past the wire's ${length} fuses`);
      const p = at + marker.length + 2 + i;
      if (bytes[p] !== 0x30 && bytes[p] !== 0x31) throw new Error(`fuse ${i} is '${String.fromCharCode(bytes[p])}' — not on or off`);
      bytes[p] = 0x30;
    }
    written.push(bytes.subarray(at + marker.length + 2, at + marker.length + 2 + length).toString('latin1'));
  }
  if (written.length === 0) throw new Error(`no fuse wire in ${file}`);
  writeFileSync(file, bytes);
  return written;
}
