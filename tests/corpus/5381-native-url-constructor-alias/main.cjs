const { URL: NativeURL } = require('node:url');

const value = new NativeURL('/path', 'https://example.com/base');
console.log(value.href, value instanceof NativeURL, ({}) instanceof NativeURL);
