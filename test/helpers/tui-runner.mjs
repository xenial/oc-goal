import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as solid from "solid-js";

// Only the native text node is replaced. The built module and Solid's browser
// reactivity run unchanged, matching the host's untracked slot component call.
const context = vm.createContext({ console });
const dependency = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
  for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
}, { context });
const dependencies = {
  "@opentui/solid/jsx-runtime": dependency({ jsx: (type, props) => ({ type, props }) }),
  "solid-js": dependency(solid),
  "@opencode/plugin/tui": dependency({ Plugin: { define: (value) => value } }),
  "./rpc.js": dependency({ goalRpc: {} }),
};
const source = await readFile(new URL("../../dist/tui.js", import.meta.url), "utf8");
const module = new vm.SourceTextModule(source, { context });
await module.link((name) => dependencies[name]);
await module.evaluate();

let claim, changed, cleanup, disposeRoot;
const requests = [];
const [sessionID, setSessionID] = solid.createSignal("first");
const [color, setColor] = solid.createSignal("#888");
const disabled = module.namespace.default.setup({ options: { enabled: false } });
cleanup = module.namespace.default.setup({
  options: {},
  client: { rpc: () => ({
    get: ({ sessionID }) => new Promise((resolve, reject) => requests.push({ sessionID, resolve, reject })),
    events: { on: (_name, callback) => { changed = callback; return () => {}; } },
  }) },
  ui: { slot: (value) => { claim = value; return () => {}; } },
  keymap: { layer() {} },
  theme: { text: { get muted() { return color(); } } },
});
const view = solid.createRoot((dispose) => {
  disposeRoot = dispose;
  return solid.createComponent(claim.render, { get sessionID() { return sessionID(); } });
});
const payload = (id, status) => ({ sessionID: id, status });
const read = () => {
  const value = typeof view === "function" ? view() : view;
  return value ? { text: value.props.children, fg: value.props.fg } : null;
};
const flush = () => new Promise(setImmediate);
const results = { disabled: disabled === undefined, initial: read() };
requests[0].resolve(payload("first", "goal:active 100tok"));
await flush();
results.fetched = read();
changed({ data: payload("first", "goal:paused 110tok") });
results.changed = read();
setColor("#aaa");
results.theme = read();
setSessionID("second");
results.afterSwitch = read();
changed({ data: payload("second", "goal:active 200tok") });
requests[1].resolve(payload("second", "stale fetched result"));
await flush();
results.staleFetch = read();
setSessionID("first");
requests[2].reject(new Error("temporary RPC failure"));
await flush();
results.failedRefresh = read();
changed({ data: payload("first", "") });
results.cleared = read();
disposeRoot();
cleanup();
console.log(JSON.stringify(results));
