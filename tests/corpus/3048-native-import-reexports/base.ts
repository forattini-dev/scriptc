console.log("base evaluated");
export let counter = 2;
export { counter as live, counter as "2", counter as "10" };
export const __value = "underscores";
export const label = "base";
export default counter;
export function bump(): number { counter++; return counter; }
