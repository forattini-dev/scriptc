/// <reference types="node" />
let fired = false;
const cancelled = setTimeout(() => console.log("cancelled"), 0);
clearTimeout(cancelled);
setTimeout(() => {
  fired = true;
  console.log(fired);
}, 0);
