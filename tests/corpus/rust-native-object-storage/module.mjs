// @ts-nocheck
export var shared = {};
export const alias = shared;
export function install() { shared.value = {count: 3}; }
export function clear() { shared = undefined; }
