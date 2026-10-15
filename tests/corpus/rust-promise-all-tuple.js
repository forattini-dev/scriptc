// @rust-only
// @no-engine
const [text, code] = await Promise.all([Promise.resolve(" hello "), Promise.resolve(7)]);
console.log(text.trim(), code + 1);
console.log((await new Response(" JS ").text()).trim().toLowerCase());
export {};
