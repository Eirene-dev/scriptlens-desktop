// A small log on this PC: what was asked, how long it took, how it ended — to tell YouTube changes apart from network
// trouble when someone reports a problem. Never the captions' text, never a token. Kept under ~512 KB (one old file).

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 512 * 1024;

export function createLog(dir, { echo = false } = {}) {
  const file = join(dir, 'scriptlens.log');
  return (event, fields = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields });
    if (echo) process.stdout.write(`${line}\n`);
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
      } catch {}
      appendFileSync(file, `${line}\n`);
    } catch {}
  };
}
