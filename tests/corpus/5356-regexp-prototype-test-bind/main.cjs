const ipv4 = RegExp.prototype.test.bind(/^127\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){2}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/)
const ipv6 = RegExp.prototype.test.bind(/^(?:(?:0{1,4}:){7}|(?:0{1,4}:){1,6}:|::)0{0,3}1$/)

console.log(ipv4('127.0.0.1'), ipv4('127.0.0.256'), ipv4('10.0.0.1'))
console.log(ipv6('::1'), ipv6('::2'), ipv6('0:0:0:0:0:0:0:1'))
