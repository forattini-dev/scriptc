import { Shadow } from './shadow.js';
const own = new Shadow(true);
const inherited = new Shadow(false);
const first = own.read;
const second = inherited.read;
console.log('values', first(), second.call(inherited));
console.log('identity', first === own.read, second === inherited.read, first === second);
delete (own as any).read;
console.log('after-delete', own.read(), own.read === inherited.read);
