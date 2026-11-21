import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const source = `.scriptc-copy-promise-${process.pid}.source`;
  const destination = `.scriptc-copy-promise-${process.pid}.destination`;
  writeFileSync(source, 'copy:promise', 'utf8');
  await copyFile(source, destination);
  console.log(readFileSync(destination, 'utf8'));
  rmSync(source, { force: true });
  rmSync(destination, { force: true });
}

void main();
