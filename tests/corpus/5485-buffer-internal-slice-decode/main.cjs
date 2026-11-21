const utf8 = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa9])
console.log(utf8.utf8Slice(3, utf8.length))
console.log(utf8.utf8Slice(4, 4))

const utf16 = Buffer.from('AΩ', 'utf16le')
console.log(utf16.ucs2Slice(0, utf16.length))
console.log(utf16.ucs2Slice(2))
