interface RichSpan {
  text: string;
  color: string;
}

interface SpanView {
  text: string;
  color?: string;
}

interface Options {
  content: SpanView[] | string[];
}

function render(options: Options): void {
  console.log(options.content.length);
}

const content: RichSpan[] = [{ text: "ready", color: "green" }];
render({ content });
