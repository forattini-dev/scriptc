import { constants, promises as fs } from 'node:fs';

async function main(): Promise<void> {
  await fs.access('package.json', constants.F_OK);
  console.log('named-promises-ok');
}

void main();
