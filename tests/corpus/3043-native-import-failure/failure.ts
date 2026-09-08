import { failure, recordAttempt } from "./state.ts";

recordAttempt();
console.log("evaluate failure");
throw failure;

export const value = 42;
