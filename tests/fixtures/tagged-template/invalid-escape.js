"use strict";
function tag(parts) { console.log("invalid", parts[0], parts.raw[0]); }
tag`\unicode`;
