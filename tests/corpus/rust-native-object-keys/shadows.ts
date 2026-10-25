// @rust-only
// @no-engine
const Object = { keys(value: string): string[] { return [value, 'local']; } };
console.log(Object.keys('value').join('|'));
export {};
