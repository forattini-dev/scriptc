let blockEndNewlines;
try {
  blockEndNewlines = new RegExp('(^|(?<!\\n))\\n+(?!\\n|$)', 'g');
} catch {
  blockEndNewlines = /\\n+(?!\\n|$)/g;
}

console.log('a\n\nb'.replace(blockEndNewlines, '!'));
