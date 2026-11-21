const state: any = { expiresAt: "2026-07-17T12:34:56Z" };

console.log(new Date(state.expiresAt).getTime());
console.log(new Date(state.expiresAt).toISOString());
