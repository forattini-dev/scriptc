export const renderer = {
  invert(text) {
    let result = '';
    for (const char of text) {
      if (char === '\n') { result += char; continue; }
      const code = char.charCodeAt(0);
      if (code >= 0x2800 && code < 0x2900) result += String.fromCharCode(0x2800 + 255 - (code - 0x2800));
      else result += char;
    }
    return result;
  },
  double: value => value * 2,
  nested: function(text) {
    const width = () => text.length;
    return width();
  },
};
