'use strict'

/** @typedef {{ name: string, domain?: string }} Cookie */

/** @param {Cookie} cookie */
function clearHostDomain(cookie) {
  if (cookie.name.startsWith('__Host-')) cookie.domain = null
  return cookie.domain === null ? 'null' : String(cookie.domain)
}

/** @type {Cookie} */
const host = { name: '__Host-session', domain: 'example.com' }
/** @type {Cookie} */
const other = { name: 'session', domain: 'example.com' }
console.log(clearHostDomain(host), host.domain === null)
console.log(clearHostDomain(other), other.domain)
