import fs from 'node:fs';

import { withFileLock } from '../../file-lock.mjs';

const [mode, lock, value] = process.argv.slice(2);

if (mode === 'hold') {
  withFileLock(lock, () => {
    process.stdout.write('locked\n');
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Number(value),
    );
  });
} else if (mode === 'increment') {
  withFileLock(lock, () => {
    const current = Number(fs.readFileSync(value, 'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    fs.writeFileSync(value, `${current + 1}\n`);
  });
} else {
  throw new Error(`unknown file-lock worker mode: ${mode}`);
}
