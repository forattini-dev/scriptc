// @rust-only
// @no-engine
const high = '😀'.charAt(0);
const low = '😀'.charAt(1);
const replacement = '�';
console.log(Buffer.from(high, 'utf16le').toString('hex'), Buffer.from(high, 'utf8').toString('hex'));
const decoded = Buffer.from([0x3d, 0xd8]).toString('utf16le');
console.log(decoded === high, JSON.stringify(decoded));
const encoded = new TextEncoder().encode(high);
console.log(encoded.length, encoded[0], encoded[1], encoded[2]);
console.log(new TextDecoder('utf-16le').decode(new Uint8Array([0x3d, 0xd8])) === replacement);
const params = new URLSearchParams();
params.append(high, low);
console.log(params.toString(), params.get(high) === replacement, params.get(replacement) === replacement);
console.log(params.has(high), params.has(replacement));
params.set(low, 'changed');
console.log(params.size, params.get(high), JSON.stringify(params.getAll(replacement)));
params.delete(high);
console.log(params.size);
const source: string[][] = [[high, low], [low, high]];
const copied = new URLSearchParams(source);
console.log(copied.size, copied.toString());
