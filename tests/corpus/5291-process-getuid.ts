/// <reference types="node" />

const uid = process.getuid ? process.getuid() : -1;
console.log(uid === -1);
console.log(typeof process.getuid);
