/// <reference types="node" />

const configured: Console | undefined = undefined;
const log = configured || console;

console.log(log === console);
log.warn("fallback");
