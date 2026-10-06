import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
export async function startFixture(visualCode?: string, htmlOverride?: string) {
  let html = await readFile(
    new URL("../fixtures/legacy-app/index.html", import.meta.url),
    "utf8",
  );
  html = htmlOverride ?? html;
  if (visualCode)
    html = html.replace(
      "</body>",
      `<canvas width=500 height=90></canvas><script>const ctx=document.querySelector('canvas').getContext('2d');ctx.font='30px monospace';ctx.fillText(${JSON.stringify(visualCode)},20,50);</script></body>`,
    );
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/forbidden" });
      res.end();
      return;
    }
    if (req.url === "/frame") {
      res.setHeader("Content-Type", "text/html");
      res.end("<label>Frame field<input></label><p>Frame text</p>");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture bind failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
