export let counter = 1;
export { counter as live, counter as "2", counter as "10" };
// A default expression snapshots this value; an export-list alias stays live.
export default counter;
export function bump(): number { counter++; return counter; }
export { bump as aliasBump };
