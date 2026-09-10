// @rust-only
// @no-engine
const input = '😀';
const high = input.charAt(0);
const low = input.slice(1);
const replacement = '�';
console.log(JSON.stringify(high), JSON.stringify(low), high.length, low.length);
console.log(high.charCodeAt(0), low.charCodeAt(0), high === low, high === replacement);
console.log(high + low === input, input.split('').join('') === input);
console.log(high.isWellFormed(), input.isWellFormed(), high.toWellFormed() === replacement);
console.log(JSON.stringify(high.repeat(2)), JSON.stringify(('  ' + high + ' ').trim()));
console.log(JSON.stringify(('a' + high).toUpperCase()), JSON.stringify(('A' + low).toLowerCase()));
console.log(JSON.stringify('x'.padStart(2, high)), JSON.stringify(input.substring(0, 1)));
console.log(input.includes(high), input.startsWith(high), input.endsWith(low));
console.log(JSON.stringify(input.replace(high, 'x')), JSON.stringify(input.replaceAll(low, 'y')));
console.log(JSON.parse(JSON.stringify(high)) === high);
console.log(JSON.parse('"' + high + '"') === high);
const map = new Map<string, number>();
map.set(high, 1); map.set(low, 2); map.set(replacement, 3);
console.log(map.size, map.get(high), map.get(low), map.get(replacement));
const object = JSON.parse('{}');
object[high] = 1; object[low] = 2; object[replacement] = 3;
console.log(JSON.stringify(object), JSON.stringify(Object.keys(object)));
let output = '';
for (let index = 0; index < input.length; index++) output += input[index];
console.log(input === output, JSON.stringify(output));
console.log('\ud83d' === high, '\ude00' === low);
const regex = new RegExp(high, 'g');
console.log(regex.test(input), JSON.stringify(regex.source));
console.log(JSON.stringify(input.match(/(.)/)), JSON.stringify(input.match(/(.)/u)));
console.log([high, low, replacement]);
try { console.log(encodeURIComponent(high)); } catch (error) { console.log(String(error)); }
function tagged(parts: TemplateStringsArray): string { return parts[0]; }
console.log(JSON.stringify(tagged`\ud83d`));
const computedKey = '\ud802' as const;
const literalKeys = { '\ud83d': 1, '\ude00': 2, '���': 3, [computedKey]: 4, ['\ud800']: 5 };
console.log(JSON.stringify(literalKeys));
console.log(literalKeys['\ud83d'], literalKeys['\ude00'], literalKeys['���'], literalKeys[computedKey]);
