console.log("left initialized");
void Promise.resolve(0).then(() => console.log("left microtask"));
export function value(): string { return "left result"; }
