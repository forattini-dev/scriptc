import { readFileSync } from 'node:fs';

const raw = readFileSync(0, 'utf8');
console.log(JSON.stringify(raw));
