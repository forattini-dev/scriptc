const codePointAt = String.prototype.codePointAt != null
  ? (value: string, index: number) => value.codePointAt(index)
  : (value: string, index: number) => {
      const first = value.charCodeAt(index);
      return (first & 0xfc00) === 0xd800
        ? (first - 0xd800) * 0x400 + value.charCodeAt(index + 1) - 0xdc00 + 0x10000
        : first;
    };

console.log(codePointAt("A", 0), codePointAt("😀", 0));
