export const state = { nested: { count: 1 } };
export function bump(): void { state.nested.count = state.nested.count + 1; }
export function replaceNested(): void { state.nested = { count: 9 }; }
