const tags = ['area', 'br', 'img'];

const variants = tags.reduce((set, tag) => {
  return set.add(tag.toLowerCase()).add(tag.toUpperCase()).add(tag);
}, new Set<string>());

console.log(variants.size, variants.has('br'), variants.has('BR'), variants.has('Img'));
