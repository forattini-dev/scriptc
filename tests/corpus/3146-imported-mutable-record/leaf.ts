export const state = { nested: { count: 1 }, label: "initial" };
export function bump(): void { state.nested.count = state.nested.count + 1; state.label = "bumped"; }
export function replace(): void { state.nested = { count: 11 }; }
