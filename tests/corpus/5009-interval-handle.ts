/// <reference types="node" />
const timer = setInterval(() => {}, 1000);
console.log(timer.hasRef());
timer.unref();
console.log(timer.hasRef());
timer.ref();
console.log(timer.hasRef());
clearInterval(timer);
