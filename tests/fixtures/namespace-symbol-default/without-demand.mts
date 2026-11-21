import * as all from './index.mts';
type Factory = (options: Record<string, string>) => unknown;
const factories = all as unknown as Record<string, Factory | undefined>;
const first = factories.android;
if (!first) throw new Error('missing');
const result: any = first({});
console.log('factory', first === all.android, result.label);
