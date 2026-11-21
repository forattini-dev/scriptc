// @ts-nocheck
function tag(parts) {
  /** @type {string[]} */
  const typed = parts;
  console.log("assigned", typed[0] = "changed");
  typed.length = 0;
  console.log("content", typed[0], typed.length);
}
tag`original`;
