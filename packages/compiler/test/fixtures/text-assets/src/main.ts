/// <reference path="./assets.d.ts" />
import prompt from "./prompt.txt";
import guide from "./guide.md" with { type: "text" };
console.log(prompt.length, guide.length);
console.log(prompt);
console.log(JSON.stringify(guide));
