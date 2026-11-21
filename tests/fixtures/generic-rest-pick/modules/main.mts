import { first } from './lib.mts';
import * as library from './lib.mts';
const object = { name: 'kept' };
console.log('module', first(3, 4), first('a', 'b'), first(object) === object, library.first(object) === object);
