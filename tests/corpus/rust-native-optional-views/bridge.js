// @rust-only
// @no-engine
export function plan(options = {}) { return options.width ?? 1; }
export const renderer = { transmit(options = {}) { return plan(options); } };
