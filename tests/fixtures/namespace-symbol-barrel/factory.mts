import { Payload } from './payload.mts';
export function factory(): { nested: { body: Payload } } {
  return { nested: { body: new Payload() } };
}
