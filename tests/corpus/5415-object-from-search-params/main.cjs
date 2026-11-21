const url = new URL('https://example.test/?a=1&a=2&b=x')
console.log(JSON.stringify(Object.fromEntries(url.searchParams)))
