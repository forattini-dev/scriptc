// @rust-only
// @no-engine
/// <reference types="node" />
setTimeout((value: string, count: number) => {
  console.log(value, count)
}, 0, 'ready', 2)
