// @dynamic
// @rust-only
// The Rust island's WHATWG URL class (the frozen C lane's engine has no
// URL global — Rust-only), Node-oracled: every string below is
// plain JavaScript the oracle evaluates natively, so components,
// base-relative parsing, setters, the searchParams binding, invalid
// inputs, and the JSON/string forms all compare byte for byte.
console.log(__island_eval("typeof URL"));
console.log(__island_eval("(() => { const u = new URL('https://user:pw@example.com:8080/a/b?x=1&y=2#frag'); return [u.href, u.origin, u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash].join(' | '); })()"));
console.log(__island_eval("(() => { const u = new URL('../c?z=9', 'https://example.com/a/b/'); u.hash = 'h'; u.pathname = '/p q'; u.port = '443'; return u.href; })()"));
console.log(__island_eval("(() => { try { new URL('nope'); return 'no throw'; } catch (e) { return e.name + ':' + e.message + ':' + e.code; } })()"));
console.log(__island_eval("(() => { const u = new URL('file:///tmp/x y'); return u.pathname + ' ' + URL.canParse('http://a') + ' ' + URL.canParse('::') + ' ' + String(URL.parse('bad')); })()"));
console.log(__island_eval("(() => { const u = new URL('https://e.com/?a=1'); u.searchParams.append('b', '2 3'); u.searchParams.set('a', '9'); return u.searchParams.get('a') + ' ' + u.search + ' ' + JSON.stringify(u) + ' ' + String(u); })()"));
console.log(__island_eval("(() => { const u = new URL('http://h/p'); u.hostname = 'x.org'; u.protocol = 'https'; u.search = 'q=1'; return u.href + ' ' + u.origin; })()"));
