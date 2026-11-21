import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'powershell.exe' : 'sh';
const args = process.platform === 'win32'
  ? ['-NoProfile', '-Command', "[Console]::Write('a' * 1024)"]
  : ['-c', "printf '%01024d' 0 | tr '0' 'a'"];
const result = spawnSync(command, args, {
  encoding: 'buffer',
  maxBuffer: Math.max(64, 32),
});
console.log(result.status, result.signal, (result.error as NodeJS.ErrnoException | undefined)?.code, result.stdout.length);
const complete = spawnSync(command, args, {
  encoding: 'buffer',
  maxBuffer: Math.max(2048, 1024),
});
console.log(complete.status, complete.signal, (complete.error as NodeJS.ErrnoException | undefined)?.code, complete.stdout.length);
