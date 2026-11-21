const regex: any = /a+/gi;
console.log("identity", regex.constructor === RegExp, regex.constructor === regex.constructor, typeof RegExp);
console.log("properties", regex.source, regex.flags, regex.lastIndex);
