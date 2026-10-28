import { unstable, type Scope } from './scope.js';
const scope: Scope = { id: 4, resources: new Map<symbol, unknown>() };
console.log('cleared', unstable(scope) === undefined, unstable() === undefined);
