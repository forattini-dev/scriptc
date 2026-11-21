const text = unescape("%uD800%u0041%uDFFF");
console.log("utf16", text.length, text.charCodeAt(0), text.charCodeAt(1), text.charCodeAt(2));
const source = String.fromCharCode(0xdfff);
console.log("preserved", unescape(source).charCodeAt(0));
