import type { Writable } from 'node:stream';
import { cursor, toggle } from './public.js';

const stream = { label: 'custom' } as unknown as Writable;
console.log('results', cursor.toggle(), cursor.toggle(true), cursor.toggle(false), cursor.toggle(undefined, stream));
console.log('identity', cursor.toggle === toggle, cursor.isHidden());
