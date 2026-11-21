import { createPool } from "./pool.js";

console.log(createPool(() => 1, () => {}, { initialSize: 3, maxSize: 8 }));
