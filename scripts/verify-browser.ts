// Exercise the production UI against the real Go backend and Delve. Server mode
// exists only in this verification build; the normal desktop opens no HTTP port.
import { mkdtemp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const artifacts = await mkdtemp(
  join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(), "lantern-browser-"),
);
const session = `lantern-check-${crypto.randomUUID().slice(0, 8)}`;
let lastAction = "setup";
const binary = join(root, ".lantern-local", "browser-check");
await mkdir(join(root, ".lantern-local"), { recursive: true });

async function command(args: string[], env?: Record<string, string | undefined>) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: env || process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw Error(`${args[0]} ${args[1]} failed (${exit})\n${stdout}\n${stderr}`);
  return stdout.trim();
}

interface BrowserResult {
  text?: string;
  result?: unknown;
  snapshot?: string;
  violations?: unknown[];
  counts?: { violations: number };
  errors?: unknown[];
}
async function browser(...args: string[]): Promise<BrowserResult> {
  lastAction = args.join(" ");
  const result = JSON.parse(
    await command(["agent-browser", "--session", session, "--json", ...args]),
  );
  if (!result.success) throw Error(JSON.stringify(result.error));
  return result.data;
}

await command(["go", "build", "-tags", "server", "-o", binary, "."]);
const cache = await command(["go", "env", "GOCACHE"]);
const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reserved"),
});
const port = reservation.port!;
reservation.stop(true);
const url = `http://127.0.0.1:${port}`;
const backend = Bun.spawn([binary], {
  cwd: root,
  env: {
    ...process.env,
    LANTERN_CONFIG_DIR: join(artifacts, "config"),
    XDG_CONFIG_HOME: join(artifacts, "config"),
    XDG_CACHE_HOME: join(artifacts, "cache"),
    XDG_DATA_HOME: join(artifacts, "data"),
    GOCACHE: cache,
    TMPDIR: artifacts,
    WAILS_SERVER_HOST: "127.0.0.1",
    WAILS_SERVER_PORT: String(port),
  },
  stdout: Bun.file(join(artifacts, "backend.stdout.log")),
  stderr: Bun.file(join(artifacts, "backend.stderr.log")),
});
const requestController = new AbortController();

async function audit() {
  const report = await browser("a11y");
  await Bun.write(join(artifacts, `a11y-${Date.now()}.json`), JSON.stringify(report, null, 2));
  if (!Array.isArray(report.violations) || report.counts?.violations !== report.violations.length)
    throw Error("Unrecognized accessibility report; the audit cannot be treated as passing");
  const violations = report.violations;
  if (violations.length) throw Error(`Accessibility violations: ${JSON.stringify(violations)}`);
}

try {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (backend.exitCode !== null) throw Error("Verification backend exited before readiness");
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* Wait for this owned backend's health endpoint. */
    }
    if (Date.now() > deadline) throw Error("Verification backend did not become ready");
    await Bun.sleep(50);
  }
  await browser("open", url);
  await browser("set", "viewport", "1440", "940");
  await browser("wait", "--text", "Delve available");
  await audit();
  await browser("click", ".app-header button:last-child");
  await browser("find", "label", "Name", "fill", "Browser orders");
  await browser("find", "label", "Package directory", "fill", join(root, "examples", "orders"));
  await browser("find", "role", "button", "click", "--name", "Launch", "--exact");
  await browser("wait", "--text", "Orders service listening");
  const output = await browser("get", "text", '[aria-label="Program and adapter output"]');
  const serviceURL = String(output.text).match(/http:\/\/127\.0\.0\.1:\d+\/order/)?.[0];
  if (!serviceURL) throw Error("The real service did not report its address");
  const source = await Bun.file(join(root, "examples", "orders", "main.go")).text();
  const line = source.split("\n").findIndex((text) => text.includes("Try a breakpoint here")) + 1;
  if (!line) throw Error("Fixture breakpoint marker is missing");
  await browser("click", '[aria-label="Go to line"]');
  await browser("find", "label", "Line number", "fill", String(line));
  await browser("find", "role", "button", "click", "--name", "Go to line", "--exact");
  await browser("wait", '[role="dialog"]', "--state", "detached");
  await browser("press", "F9");
  await browser("wait", "--text", `main.go:${line}`);
  const request = fetch(serviceURL, { signal: requestController.signal })
    .then(async (response) => ({ status: response.status, body: await response.json() }))
    .catch((error) => ({ error: String(error) }));
  await browser("wait", '[title="subtotal: 0"]');
  await browser("find", "label", "Watch expression", "fill", "subtotal");
  await browser("find", "role", "button", "click", "--name", "Add watch", "--exact");
  await browser("find", "role", "button", "click", "--name", "Expand order", "--exact");
  await browser("find", "role", "button", "click", "--name", "Step over", "--exact");
  await browser("wait", '[title^="subtotal: 2400"]');
  const comparison = await browser(
    "eval",
    'document.querySelectorAll(".value-changed").length > 0',
  );
  if (comparison.result !== true)
    throw Error("Changed-value highlighting did not survive stepping");
  await browser("screenshot", join(artifacts, "paused-light.png"));
  await audit();
  await browser("click", '[aria-label="Settings"]');
  await browser("select", '[role="dialog"] select', "dark");
  await browser("find", "role", "button", "click", "--name", "Save settings", "--exact");
  await browser("wait", '[role="dialog"]', "--state", "detached");
  await browser("wait", 'html[data-mode="dark"]');
  await browser("screenshot", join(artifacts, "paused-dark.png"));
  await audit();
  await browser("set", "viewport", "320", "740");
  const narrow = await browser("eval", "document.documentElement.scrollWidth <= window.innerWidth");
  if (narrow.result !== true) throw Error("Document overflows at 320 CSS pixels");
  await browser("click", '[aria-label="Toggle inspector"]');
  await browser("wait", '[title^="subtotal: 2400"]');
  await audit();
  await browser("screenshot", join(artifacts, "compact-dark.png"));
  await browser("set", "viewport", "1440", "940");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    `Remove breakpoint at main.go line ${line}`,
    "--exact",
  );
  await browser("wait", "--fn", 'document.querySelectorAll(".breakpoint-row").length === 0');
  await browser("find", "role", "button", "click", "--name", "Continue", "--exact");
  const response = await Promise.race([
    request,
    Bun.sleep(15_000).then(() => {
      throw Error("Service request did not complete after Continue");
    }),
  ]);
  if (!("status" in response) || response.status !== 200 || response.body.total !== 2800)
    throw Error(`Unexpected service response: ${JSON.stringify(response)}`);
  await browser("reload");
  await browser("wait", 'html[data-mode="dark"]');
  await browser("wait", '[aria-label="Stop session"]');
  await browser("click", '[aria-label="Stop session"]');
  await browser("wait", "--text", "disconnected");
  const errors = await browser("errors");
  if (errors.errors?.length) throw Error(`Browser errors: ${JSON.stringify(errors.errors)}`);
  console.log(
    `Verified real service debugging, stepping, watches, value comparison, both themes, compact layout, persistence, and accessibility.\nArtifacts: ${artifacts}`,
  );
} catch (error) {
  console.error(`Failed action: ${lastAction}`);
  try {
    await browser("screenshot", join(artifacts, "failure.png"));
    console.error((await browser("snapshot", "-i")).snapshot);
  } catch {
    /* Preserve the original failure. */
  }
  console.error(`Verification artifacts: ${artifacts}`);
  throw error;
} finally {
  requestController.abort();
  try {
    await browser("close");
  } catch {
    /* The browser may not have launched. */
  }
  backend.kill("SIGTERM");
  await Promise.race([backend.exited, Bun.sleep(10_000)]);
  if (backend.exitCode === null) {
    backend.kill("SIGKILL");
    await backend.exited;
  }
}
