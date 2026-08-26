// Object.hasOwn over checked-dynamic values: objects consult their own
// dictionary, arrays expose dense indexes and length, keys ToString, and
// nullish receivers throw catchable TypeErrors.
"use strict";

const object = JSON.parse('{"a":1,"present":null}');
console.log(Object.hasOwn(object, "a"), Object.hasOwn(object, "present"), Object.hasOwn(object, "missing"));

const array = JSON.parse('[1,null]');
console.log(Object.hasOwn(array, "0"), Object.hasOwn(array, "1"), Object.hasOwn(array, "2"));
console.log(Object.hasOwn(array, "length"), Object.hasOwn(array, "01"));
console.log(Object.hasOwn(array, 1), Object.hasOwn(array, true));

const nil = JSON.parse("null");
try { Object.hasOwn(nil, "x"); } catch (error) { console.log(error.name, error.message); }

const absent = JSON.parse("[]")[0];
try { Object.hasOwn(absent, "x"); } catch (error) { console.log(error.name, error.message); }
