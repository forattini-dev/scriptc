// @transform-types
declare const BUILD_NAME: string
declare const BUILD_CHANNEL: string

const name = typeof BUILD_NAME === "string" ? BUILD_NAME : "local"
const channel = typeof BUILD_CHANNEL === "string" ? BUILD_CHANNEL : "local"
console.log(name, channel, typeof BUILD_NAME)
