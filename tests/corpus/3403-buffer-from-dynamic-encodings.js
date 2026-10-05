// @rust-only
// @no-engine
function hex(value) { return Buffer.from(value, 'hex').toString('hex'); }
function base64(value) { return Buffer.from(value, 'base64').toString('utf8'); }
function latin1(value) { return Buffer.from(value, 'latin1').toString('hex'); }
function utf16(value) { return Buffer.from(value, 'utf16le').toString('hex'); }
console.log(hex(JSON.parse('"abcdz"')));
console.log(base64(JSON.parse('"aGVsbG8="')));
console.log(latin1(JSON.parse('"ÿπ"')));
console.log(utf16(JSON.parse('"☃"')));
