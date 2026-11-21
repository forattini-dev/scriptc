export function write(value) { value.x = 9; return String(value.x); }
export function erase(value) { delete value.x; return String(value.x); }
