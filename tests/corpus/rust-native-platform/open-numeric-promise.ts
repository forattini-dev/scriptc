import { constants, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';

async function main(): Promise<void> {
  const path = process.cwd() + '/scriptc-open-numeric-' + process.pid;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR;
  const handle = await open(path, flags);
  await handle.close();
  try {
    await open(path, flags);
  } catch (error) {
    console.log((error as NodeJS.ErrnoException).code);
  }
  rmSync(path);
  console.log('closed');
}

void main();
