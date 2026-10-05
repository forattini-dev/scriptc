const readName = (error: Error): string => error.constructor.name;
const Shadow = class extends Error { ["constructor"]() {} };
console.log(readName(new Shadow("message")));
