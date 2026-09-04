/// <reference path="./asset-fs.d.ts" />
/// <reference path="./assets.d.ts" />
import { readFileSync } from "node:fs";
import sound from "./sound.mp3" with { type: "file" };
import text from "./prompt.txt";
console.log(typeof sound, sound.endsWith(".mp3"));
const bytes = readFileSync(sound);
console.log(bytes.length, bytes[0], bytes[4], bytes[5]);
console.log(text.length);
