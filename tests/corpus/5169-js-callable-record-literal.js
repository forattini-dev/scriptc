// @ts-nocheck
function createRenderer(prefix) {
  let previous = "";
  const render = (content) => {
    if (content !== previous) console.log(prefix + content);
    previous = content;
  };
  render.clear = () => {
    previous = "";
    console.log("clear");
  };
  render.sync = (content) => {
    previous = content;
  };
  return render;
}

const render = createRenderer("value:");
render("a");
render("a");
render.sync("b");
render("c");
render.clear();
