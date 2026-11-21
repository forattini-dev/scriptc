// @ts-nocheck
"use strict";
const object = {
  value: 3,
  tag(parts, value) { console.log("method", this.value, parts[0], value); }
};
object.tag`head${7}`;
