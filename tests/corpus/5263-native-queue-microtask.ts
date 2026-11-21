/// <reference types="node" />
console.log("sync");
queueMicrotask((): void => console.log("microtask"));
setTimeout((): void => console.log("timer"), 0);
