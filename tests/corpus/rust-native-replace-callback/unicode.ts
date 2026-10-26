let offsets = "";
const separated: string = JSON.parse('"|\\ud83d|\\ude00|x|"');
console.log("units", "😀x".replace(/(?:)/g, (match, offset) => { offsets = offsets + String(offset) + ";"; return "|"; }) === separated);
console.log("offsets", offsets);
offsets = "";
console.log("points", "😀x".replace(/(?:)/gu, (match, offset) => { offsets = offsets + String(offset) + ";"; return "|"; }));
console.log("offsets", offsets);
const input: string = JSON.parse('"\\ud800x"');
console.log("surrogate", input.replace(/(.)/g, (match) => match) === input);
console.log("capture", "😀z".replace(/(😀)/u, (match, capture, offset, original) => {
  console.log("unicode", capture === "😀", offset === 0, original === "😀z"); return "U";
}));
