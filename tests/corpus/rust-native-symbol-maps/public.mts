import { choose, chooseBlock, select, type Scope } from './scope.js';
const scope: Scope = { id: 4, resources: new Map<symbol, unknown>() };
const present = choose(scope);
const missing = choose();
console.log('choose', present === scope, present.id, missing.id, missing.resources.size);
console.log('block', chooseBlock(scope) === scope, chooseBlock().id);
console.log('nullable', select(scope, missing) === scope, select(null, missing) === missing);
const equalContents: Scope = { id: 4, resources: scope.resources };
console.log('identity', scope === scope, scope !== equalContents, choose(scope) !== equalContents);
