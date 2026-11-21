import * as presets from './lib.mts';
type Factory = () => unknown;
const factories = presets as unknown as Record<string, Factory | undefined>;
const factory = factories['create'];
if (!factory) throw new Error('missing factory');
const created = factory() as { value: { [Symbol.iterator](offset: number): number } };
console.log('symbol', created.value[Symbol.iterator](3));
