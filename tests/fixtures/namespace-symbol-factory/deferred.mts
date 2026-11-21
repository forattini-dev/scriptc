import * as presets from './lib.mts';
type Factory = () => unknown;
const factories = presets as unknown as Record<string, Factory | undefined>;
const factory = factories['create'];
if (!factory) throw new Error('missing factory');
console.log('factory', typeof factory());
