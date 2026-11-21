interface ToolDelta {
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}
interface ToolEvent {
  readonly type: string;
  readonly name: string;
  readonly arguments: string;
}

abstract class BaseProvider {
  protected abstract parseEvent(chunk: string, depth: number): ToolEvent | null;

  collect(chunks: string[]): string[] {
    const out: string[] = [];
    for (const chunk of chunks) {
      const event = this.parseEvent(chunk, out.length);
      if (event) out.push(`${event.type}:${event.name}(${event.arguments})`);
    }
    return out;
  }
}

class ToolProvider extends BaseProvider {
  protected parseEvent(chunk: string, depth: number): ToolEvent | null {
    const delta = JSON.parse(chunk) as ToolDelta;
    if (delta.id) {
      return {
        type: "tool_call",
        name: delta.function?.name || "",
        arguments: delta.function?.arguments || "",
      };
    }
    if (delta.function?.arguments) {
      return { type: "delta", name: String(depth), arguments: delta.function.arguments };
    }
    return null;
  }
}

class EmptyProvider extends BaseProvider {
  protected parseEvent(_chunk: string, _depth: number): ToolEvent | null {
    return null;
  }
}

const chunks = ['{"id":"1","function":{"name":"read","arguments":"{}"}}', '{"function":{"arguments":"x"}}', "{}"];
console.log(new ToolProvider().collect(chunks).join(" | "));
console.log(new EmptyProvider().collect(chunks).length);

function count(): number {
  return arguments.length;
}
console.log(count());
