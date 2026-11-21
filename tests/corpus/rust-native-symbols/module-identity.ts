// @rust-only
// @no-engine
// @ts-nocheck
import { resourceKey, resourceKey as alias, otherKey } from './module-key.ts';

const methods = new Map<symbol, string>();
methods.set(resourceKey, 'dispose');
methods.set(otherKey, 'other');
console.log('identity', resourceKey === alias, resourceKey === (otherKey as symbol));
console.log('lookup', methods.get(alias), methods.get(otherKey), methods.size);
