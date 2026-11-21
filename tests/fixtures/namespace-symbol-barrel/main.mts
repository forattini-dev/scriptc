import * as all from './index.mts';
import { Payload } from './payload.mts';
console.log('typed', new Payload()[Symbol.iterator](3));
type Factory = (options: Record<string, string>) => unknown;
const factories = all as unknown as Record<string, Factory | undefined>;
const factory = factories.factory;
if (!factory) throw new Error('missing');
const value: any = factory({});
console.log(value.nested.body[Symbol.iterator](3));
