import * as all from './weak-map.mts';
type Factory = () => unknown;
const factories = all as unknown as Record<string, Factory | undefined>;
const factory = factories.factory;
if (!factory) throw new Error('missing');
const value: any = factory();
const key = {};
value.holder.table.set(key, 7);
console.log(value.holder.table.get(key));
