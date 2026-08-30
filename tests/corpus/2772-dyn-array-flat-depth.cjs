'use strict';

const values = JSON.parse('[1,[2,[3,[4]]]]');
const flattened = values.flat(2);
console.log(flattened.join('|'), JSON.stringify(values), flattened === values);
