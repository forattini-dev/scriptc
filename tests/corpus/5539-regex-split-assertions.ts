const cookie = /,(?=\s*[a-zA-Z0-9_-]+=)/g;
const header = 'session=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT, theme=dark, flag=yes';
cookie.lastIndex = 4;
console.log('cookie', JSON.stringify(header.split(cookie)), cookie.lastIndex);
console.log('limit', JSON.stringify(header.split(cookie, 0)), JSON.stringify(header.split(cookie, 1)), JSON.stringify(header.split(cookie, 2)));
console.log('empty', JSON.stringify(''.split(/(?=a)/)), JSON.stringify('a'.split(/(?=a)/)));
console.log('zero width', JSON.stringify('aba'.split(/(?=b)/)), JSON.stringify('abc'.split(/(?!b)/)));
console.log('groups', JSON.stringify('a-b_c'.split(/(?:-|_)/)), JSON.stringify('xayb'.split(/(?<!x)(?:a|b)/)));
console.log('escaped', JSON.stringify('a(b)c'.split(/[()]/)), JSON.stringify('a(b'.split(/\(/)));
