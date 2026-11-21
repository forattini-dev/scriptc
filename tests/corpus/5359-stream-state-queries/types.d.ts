import 'node:stream'

declare module 'node:stream' {
  export function isDisturbed(stream: any): boolean
  export function isDestroyed(stream: any): boolean | null
  export function isErrored(stream: any): boolean
  export function isReadable(stream: any): boolean | null
}
