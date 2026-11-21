type Directive = { type: string; path?: string; url?: string };
function analyze(lines: string[]) {
  const directives: Directive[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('sitemap:')) {
      directives.push({type: 'sitemap', url: trimmed.slice(8).trim()});
    } else if (trimmed.startsWith('disallow:')) {
      directives.push({type: 'disallow', path: trimmed.slice(9).trim()});
    }
  }
  return {
    rules: directives.length,
    sitemaps: directives.filter(d => d.type === 'sitemap').map(d => d.url!),
    disallowed: directives.filter(d => d.type === 'disallow').slice(0, 10).map(d => d.path!),
  };
}
console.log(JSON.stringify(analyze(['sitemap:  /one  ', 'disallow: /private', 'sitemap: /two'])));
console.log(JSON.stringify(analyze(['disallow: /x'])));
console.log(JSON.stringify(analyze([])));
