import * as all from './generic-symbol.mts';
type Factory = () => unknown;
const factories = all as unknown as Record<string, Factory | undefined>;
const factory = factories.factory;
if (!factory) throw new Error('missing');
const value: any = factory();
console.log(value.payload[Symbol.iterator](7));
