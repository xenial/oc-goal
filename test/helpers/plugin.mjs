import plugin from "../../dist/index.js";

export const tokens = (input = 100, output = 10, read = 0, reasoning = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } });
export const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

/** Exercise the shipped entrypoint with the installed SDK's event shapes. */
export async function harness(t, options = {}, environment = {}) {
  const db = environment.db ?? new Map(), tools = new Map(), commands = new Map(), sent = [], changes = [], interrupts = [];
  const location = environment.location ?? { directory: "C:/test/project" };
  const sessionLocation = environment.sessionLocation ?? location;
  let rpc, next, contextHook, closed = false, busy = false, waiters = [], queue = [], pendingInbox = [], seq = 0, stepID;
  let usage = tokens(0, 0);
  let selectedAgent = "build";
  const enqueue = (event, done = () => {}) => {
    const item = { event, done };
    if (next) { const resume = next; next = null; resume(item); }
    else queue.push(item);
  };
  const context = {
    location,
    options,
    storage: {
      get: async (key) => structuredClone(db.get(key)),
      set: async (key, value) => db.set(key, structuredClone(value)),
      remove: async (key) => db.delete(key),
    },
    tool: { transform: async (cb) => { cb({ add: (tool) => tools.set(tool.name, tool) }); return { dispose() {} }; } },
    command: { transform: async (cb) => { cb({ add: (command) => commands.set(command.name, command) }); return { dispose() {} }; } },
    rpc: { register: async (_contract, handlers) => {
      rpc = handlers;
      return { dispose() {}, events: { emit: async (_name, data) => changes.push(data) } };
    } },
    session: {
      hook: async (_name, callback) => { contextHook = callback; return { dispose() {} }; },
      get: async () => ({ agent: selectedAgent, location: sessionLocation }),
      wait: async () => { if (busy) await new Promise((resolve) => waiters.push(resolve)); },
      interrupt: async (input) => { interrupts.push(input); return { interrupted: busy }; },
      synthetic: async (input) => {
        const id = `input-${++seq}`;
        sent.push(input);
        const data = { sessionID: "s", inboxID: id, item: { type: "synthetic", delivery: input.delivery, payload: { text: input.text, metadata: input.metadata } } };
        pendingInbox.push(id);
        enqueue({ type: "session.inbox.enqueued", location: sessionLocation, data });
        return { id };
      },
    },
    event: { async *subscribe({ signal }) {
      const abort = () => { closed = true; if (next) { next(null); next = null; } };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (!closed) {
          const entry = queue.length ? queue.shift() : await new Promise((resolve) => { next = resolve; });
          if (!entry) break;
          yield entry.event;
          entry.done();
        }
      } finally { signal.removeEventListener("abort", abort); }
    } },
  };
  const cleanup = await plugin.setup(context);
  t.after(async () => { await cleanup(); });
  const emit = async (type, data = {}, sessionID = "s", eventLocation = sessionLocation) => {
    if (type === "session.execution.started") busy = true;
    if (type === "session.agent.selected") selectedAgent = data.agent;
    await new Promise((resolve) => enqueue({ type, ...(eventLocation ? { location: eventLocation } : {}), data: { sessionID, ...data } }, resolve));
    if (type.startsWith("session.execution.") && type !== "session.execution.started") {
      busy = false;
      for (const resolve of waiters.splice(0)) resolve();
    }
    await flush();
  };
  const step = async (agent = selectedAgent) => {
    stepID = `step-${++seq}`;
    await emit("session.step.started", { agent, assistantMessageID: stepID });
    return stepID;
  };
  return {
    db, tools, commands, sent, changes, interrupts, emit, context,
    goal: (id = "s") => structuredClone(db.get(`goal:${id}`)),
    continuations: () => sent.filter((m) => m.metadata.purpose === "continuation"),
    command: async (argument, sessionID = "s") => { const result = await rpc.command({ sessionID, argument }); await flush(); return result; },
    tool: async (name, input = {}, sessionID = "s") => {
      const response = await tools.get(name).execute(input, { sessionID });
      await flush();
      return JSON.parse(response.content);
    },
    get: (sessionID = "s") => rpc.get({ sessionID }),
    modelContext: async () => {
      const input = { sessionID: "s", messages: [] };
      await contextHook?.(input);
      return input.messages;
    },
    start: async (agent = selectedAgent) => {
      selectedAgent = agent;
      await emit("session.execution.started");
      for (const inboxID of pendingInbox.splice(0)) await emit("session.inbox.delivered", { inboxID });
      return step(agent);
    },
    step,
    settle: async (value = tokens(), finish = "stop") => {
      await emit("session.step.ended", { assistantMessageID: stepID, tokens: value, finish });
      usage = {
        input: usage.input + value.input, output: usage.output + value.output, reasoning: usage.reasoning + value.reasoning,
        cache: { read: usage.cache.read + value.cache.read, write: usage.cache.write + value.cache.write },
      };
      await emit("session.usage.updated", { tokens: usage });
    },
    succeed: async () => { await emit("session.execution.succeeded"); await emit("session.idle"); },
    shell: async (success = false, executed = true) => {
      const id = `tool-${++seq}`;
      await emit("session.tool.input.started", { id, name: "shell", assistantMessageID: stepID });
      await emit("session.tool.called", { id, executed, assistantMessageID: stepID, input: {} });
      await emit(success ? "session.tool.success" : "session.tool.failed", { id, executed, assistantMessageID: stepID });
    },
  };
}
