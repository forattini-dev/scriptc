// @dynamic
// Island web encoders and small globals, differentially vs Node: each
// __island_eval snippet runs under the island's pure-JS implementations
// (scriptc) AND under a global eval with Node's REAL implementations
// (island-shim.mjs) — results must match byte-for-byte.

// TextEncoder: ascii, 2/3/4-byte utf-8, and lone-surrogate replacement
console.log(__island_eval("new TextEncoder().encode('Az 09~ é§ € 한 😀').join(',')"));
console.log(__island_eval("new TextEncoder().encode('a' + String.fromCharCode(0xd800) + 'b').join(',')"));
console.log(__island_eval("new TextEncoder().encoding + ' ' + new TextEncoder().encode().length"));

// TextDecoder: round trips, byte-at-a-time streaming, maximal-subpart
// replacement, BOM stripping, state reset between non-stream decodes
console.log(__island_eval("new TextDecoder().decode(new TextEncoder().encode('héllo 😀 €12'))"));
console.log(__island_eval("(() => { const d = new TextDecoder(); const b = new TextEncoder().encode('a😀é'); let s = ''; for (let i = 0; i < b.length; i++) s += d.decode(b.subarray(i, i + 1), { stream: true }); return s + d.decode(); })()"));
console.log(__island_eval("JSON.stringify(new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62])))"));
console.log(__island_eval("JSON.stringify(new TextDecoder().decode(new Uint8Array([0xc2, 0x41])))"));
console.log(__island_eval("JSON.stringify(new TextDecoder().decode(new Uint8Array([0xf0, 0x9f, 0x98])))"));
console.log(__island_eval("JSON.stringify(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))) + ' ' + JSON.stringify(new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])))"));
console.log(__island_eval("(() => { const d = new TextDecoder(); const a = d.decode(new Uint8Array([0xe2, 0x82])); const b = d.decode(new Uint8Array([0xac])); return JSON.stringify(a) + ' ' + JSON.stringify(b); })()"));
console.log(__island_eval("(() => { try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])); return 'no-throw'; } catch (e) { return String(e instanceof TypeError); } })()"));
console.log(__island_eval("new TextDecoder().encoding + ' ' + new TextDecoder().fatal + ' ' + new TextDecoder().ignoreBOM"));

// URLSearchParams: parsing, encoding, mutation, iteration, sorting
console.log(__island_eval("new URLSearchParams('a=1&b=two&a=3').getAll('a').join('|')"));
console.log(__island_eval("(() => { const p = new URLSearchParams({ x: '1', 'y z': '2 3' }); p.append('c d', 'e&f=g'); p.set('x', 'one'); return p.toString(); })()"));
console.log(__island_eval("new URLSearchParams('a+b=c%20d&%C3%A9=%E2%82%AC').toString()"));
console.log(__island_eval("new URLSearchParams('x=😀').toString()"));
console.log(__island_eval("(() => { const p = new URLSearchParams('b=2&a=1&b=1'); p.sort(); return p.toString() + ' ' + p.size + ' ' + p.get('missing'); })()"));
console.log(__island_eval("JSON.stringify([...new URLSearchParams('flag&x=1')])"));
console.log(__island_eval("(() => { const p = new URLSearchParams('a=1&b=2&a=3'); p.delete('a'); return p.toString() + ' ' + p.has('a') + ' ' + p.has('b', '2'); })()"));
console.log(__island_eval("(() => { const p = new URLSearchParams('a=1&b=2'); const seen = []; p.forEach((value, key) => { seen.push(key + value); if (key === 'a') p.append('c', '3'); }); return seen.join('|'); })()"));
console.log(__island_eval("(() => { const p = new URLSearchParams('a=1&b=2&c=3'); const it = p.entries(); const first = it.next().value.join(''); p.delete('b'); return first + '|' + [...it].map((pair) => pair.join('')).join('|'); })()"));
console.log(__island_eval("(() => { const p = new URLSearchParams('a=1&b=2&a=3&c=4'); const it = p.entries(); const first = it.next().value.join(''); p.set('a', '9'); return first + '|' + [...it].map((pair) => pair.join('')).join('|'); })()"));
console.log(__island_eval("(() => { const p = new URLSearchParams('b=2&a=1&c=3'); const it = p.entries(); const first = it.next().value.join(''); p.sort(); return first + '|' + [...it].map((pair) => pair.join('')).join('|'); })()"));
console.log(__island_eval("new URLSearchParams([['é', '😀']]).toString()"));

// btoa/atob
console.log(__island_eval("[btoa(''), btoa('a'), btoa('ab'), btoa('abc'), btoa('hello world')].join(' ')"));
console.log(__island_eval("JSON.stringify([atob(''), atob('YQ=='), atob('YWJj'), atob('aGVsbG8gd29ybGQ='), atob(' YW Jj ')])"));
console.log(__island_eval("String(atob(btoa('binary\\u0000\\u0001\\u00fedata')) === 'binary\\u0000\\u0001\\u00fedata')"));
console.log(__island_eval("(() => { const seen = []; for (const call of [() => btoa('€'), () => atob('%')]) { try { call(); } catch (error) { seen.push(error.constructor.name + ':' + error.name + ':' + error.code + ':' + (typeof DOMException === 'function' && error instanceof DOMException)); } } return seen.join('|'); })()"));

// console: the island shim writes to the SAME stdout, String()-formatted
console.log(__island_eval("console.log('island console', 1.5, true); 'after-console'"));
console.log(__island_eval("console.log(Symbol('island')); 'after-symbol-console'"));
