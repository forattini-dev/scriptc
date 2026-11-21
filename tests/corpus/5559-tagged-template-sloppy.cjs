// @ts-nocheck
function tag(parts) {
  parts[0] = "changed";
  console.log("write", parts[0]);
}
tag`original`;
