// @dynamic
// @rust-only
// @island-module: ./source.ts
import { makeSource, inspectCopy, mutate, makeProxy, proxyReport } from './source.ts';
const source: any = makeSource();
const copy: any = { ...source, first: 4, after: 6 };
console.log(inspectCopy(copy, source));
console.log(mutate(copy));
console.log(inspectCopy(copy, source));
const proxyCopy: any = { ...makeProxy() };
console.log(proxyReport(proxyCopy));
