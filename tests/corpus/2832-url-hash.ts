// URL.hash — "#" + fragment, but "" for BOTH no fragment at all and a BARE
// '#' (which href still keeps). The fragment runs to the end of the input, so
// later '#' and '?' characters belong to it. Same empty-vs-absent rule the
// search getter applies to the query.
const none = new URL("https://x.com/p");
const simple = new URL("https://x.com/p#frag");
const bare = new URL("http://a.com/#");
const barePath = new URL("http://a.com/p#");
const nested = new URL("https://a.com/#a#b");
const withQuery = new URL("http://a.com/#frag?x");
const afterQuery = new URL("https://x.com:8443/p?q=1#frag");
const encoded = new URL("http://a.com/#a b");
const fileUrl = new URL("file:///tmp/x#top");
const opaque = new URL("mailto:x@y.com#z");
console.log(`<${none.hash}>`);
console.log(`<${simple.hash}>`);
console.log(`<${bare.hash}>`);
console.log(`<${barePath.hash}>`);
console.log(`<${nested.hash}>`);
console.log(`<${withQuery.hash}>`);
console.log(`<${afterQuery.hash}>`);
console.log(`<${encoded.hash}>`);
console.log(`<${fileUrl.hash}>`);
console.log(`<${opaque.hash}>`);
// The bare '#' survives in href even though hash answers "".
console.log(bare.href, bare.hash.length);
console.log(barePath.href, barePath.hash.length);
// hash never overlaps search or pathname.
console.log(afterQuery.pathname, afterQuery.search, afterQuery.hash);
console.log(withQuery.search.length, withQuery.hash);
// href reassembles from the parts.
console.log(simple.href === `${simple.origin}${simple.pathname}${simple.search}${simple.hash}`);
