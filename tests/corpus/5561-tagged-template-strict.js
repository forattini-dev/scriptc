// @ts-nocheck
"use strict";
function tag(parts) {
  try { parts[0] = "changed"; } catch (error) { console.log("index", error.name); }
  try { parts.raw[0] = "changed"; } catch (error) { console.log("raw", error.name); }
  console.log("content", parts[0], parts.raw[0]);
}
tag`original`;
