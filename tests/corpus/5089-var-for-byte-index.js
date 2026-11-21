function decode() {
  var bytes = new Uint8Array([65, 66]);
  var output = "";
  for (var i = 0, length = bytes.byteLength; i < length; i++) {
    output += String.fromCharCode(bytes[i]);
  }
  return output;
}
console.log(decode());
