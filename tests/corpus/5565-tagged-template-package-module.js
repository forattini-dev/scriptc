// @ts-nocheck
function tag(parts) {
  try { parts[0] = "changed"; } catch (error) { console.log("index", error.name); }
  console.log("content", parts[0]);
}
tag`original`;
