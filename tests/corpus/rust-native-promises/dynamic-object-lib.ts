console.log("object initialized");
export const shared = { value: 1 };
export function read(): number { return shared.value; }
