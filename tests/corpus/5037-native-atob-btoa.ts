/// <reference lib="dom" />
const credentials = btoa(`${"client"}:${"secret"}`);

console.log(credentials);
console.log(atob(credentials));
