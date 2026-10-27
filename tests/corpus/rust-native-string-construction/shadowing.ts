// @rust-only
// @no-engine
export {};
function shadow():void{
 const String={fromCharCode:(code:number):string=>"unit-"+code,fromCodePoint:(code:number):string=>"point-"+code};
 console.log("shadow",String.fromCharCode(65),String.fromCodePoint(66));
}
shadow();
console.log("standard",String.fromCharCode(65),String.fromCodePoint(0x1f600));
