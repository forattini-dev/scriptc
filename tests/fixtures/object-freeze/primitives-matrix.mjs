{ const input=7; const result=Object.freeze(input); console.log(0,0,Object.is(result,input)); console.log(0,1,typeof result); console.log(0,2,String(result)); console.log(0,3,result===input); }
{ const input=-0; const result=Object.freeze(input); console.log(1,0,Object.is(result,input)); console.log(1,1,typeof result); console.log(1,2,String(result)); console.log(1,3,result===input); }
{ const input=NaN; const result=Object.freeze(input); console.log(2,0,Object.is(result,input)); console.log(2,1,typeof result); console.log(2,2,String(result)); console.log(2,3,result===input); }
{ const input=true; const result=Object.freeze(input); console.log(3,0,Object.is(result,input)); console.log(3,1,typeof result); console.log(3,2,String(result)); console.log(3,3,result===input); }
{ const input="hello"; const result=Object.freeze(input); console.log(4,0,Object.is(result,input)); console.log(4,1,typeof result); console.log(4,2,String(result)); console.log(4,3,result===input); }
{ const input=42n; const result=Object.freeze(input); console.log(5,0,Object.is(result,input)); console.log(5,1,typeof result); console.log(5,2,String(result)); console.log(5,3,result===input); }
{ const input=null; const result=Object.freeze(input); console.log(6,0,Object.is(result,input)); console.log(6,1,typeof result); console.log(6,2,String(result)); console.log(6,3,result===input); }
{ console.log(7,0,Object.is(Object.freeze(undefined),undefined)); console.log(7,1,typeof Object.freeze(undefined)); console.log(7,2,String(Object.freeze(undefined))); console.log(7,3,Object.freeze(undefined)===undefined); }
