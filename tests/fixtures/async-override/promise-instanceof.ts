async function run(): Promise<number> { return 1; }
const value = run();
console.log(value instanceof Promise);
