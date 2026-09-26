// Checked-dynamic unary bitwise-not: JS ToNumber across JSON kinds, then
// ToInt32/complement. The object and array rows pin ordinary-to-primitive
// behavior; this stays engine-free.
const values = JSON.parse('[0,1,-1,1.5,"2","x",true,false,null,[],[1],{}]');

for (const value of values) console.log(~value);
