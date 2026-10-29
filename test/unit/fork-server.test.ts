import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerForkServer, type ForkDaemon, type ForkHostAccess } from "../../server/fork/register";
import { describe, expect, it, vi } from "vitest";

type Handler = (input: unknown) => Promise<unknown>;

interface HistoryAttachment {
  type: "text";
  mimeType: "text/plain";
  contextKind?: string;
  title?: string | null;
  text: string;
}

function fakeDaemon(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    buildAgentForkContext: vi.fn(async () => ({
      requestId: "r", agentId: "agent-a",
      attachment: { type: "text", mimeType: "text/plain", contextKind: "chat_history", text: "HISTORY" } satisfies HistoryAttachment,
      itemCount: 3, boundaryMessageId: "m1", boundaryCursor: { epoch: "e", seq: 9 }, error: null,
    })),
    createAgent: vi.fn(async (_options: Record<string, unknown>) => ({ id: "agent-new" })),
    createWorkspace: vi.fn(async (_options: Record<string, unknown>) => ({
      workspaceId: "wks-new", agent: { id: "agent-branch" }, error: null,
    })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

type Daemon = ReturnType<typeof fakeDaemon>;

function hostWith(daemon: Daemon | null): ForkHostAccess {
  // The fake matches ForkDaemon structurally; the cast keeps Mock types out of it.
  return { available: () => daemon !== null, connect: async () => daemon as unknown as ForkDaemon | null };
}

async function register(host: ForkHostAccess): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  const server = {
    handle(contract: { name: string }, handler: Handler) {
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext;
  registerForkServer(server, host);
  return handlers;
}

const input = {
  agentId: "agent-a",
  boundary: { epoch: "e", seq: 9 },
  messageId: "m1",
  text: "Continue from here, but keep the tests green.",
  source: {
    provider: "codex",
    cwd: "/workspace",
    model: "sol",
    thinkingOptionId: "medium",
    modeId: "code",
    featureValues: null,
    workspaceId: "ws-1",
    title: "Source agent",
  },
};

describe("fork.create server", () => {
  it("builds the turn's attachment and creates the agent with it and the first message", async () => {
    const daemon = fakeDaemon();
    const handlers = await register(hostWith(daemon));
    const result = await handlers.get("fork.create")!(input);
    expect(result).toEqual({ agentId: "agent-new", workspaceId: "ws-1", error: null });
    expect(daemon.buildAgentForkContext).toHaveBeenCalledExactlyOnceWith("agent-a",
      { boundaryCursor: { epoch: "e", seq: 9 }, boundaryMessageId: "m1" });
    const options = daemon.createAgent.mock.calls[0]![0];
    expect(options.workspaceId).toBe("ws-1");
    expect(options.attachments).toEqual([{ type: "text", mimeType: "text/plain", contextKind: "chat_history", text: "HISTORY" }]);
    expect(options.initialPrompt).toBe(input.text);
    expect(options.config).toEqual({
      provider: "codex", cwd: "/workspace", title: "Source agent", model: "sol", thinkingOptionId: "medium", modeId: "code",
    });
  });

  it("falls back to the message ID when the cursor is missing and omits empty config fields", async () => {
    const daemon = fakeDaemon();
    const handlers = await register(hostWith(daemon));
    await handlers.get("fork.create")!({ ...input, boundary: null,
      source: { ...input.source, model: null, thinkingOptionId: null, modeId: null } });
    expect(daemon.buildAgentForkContext).toHaveBeenCalledExactlyOnceWith("agent-a", { boundaryMessageId: "m1" });
    const options = daemon.createAgent.mock.calls[0]![0];
    expect(options.config).toEqual({ provider: "codex", cwd: "/workspace", title: "Source agent" });
  });

  it("lands the fork in a new workspace built around the source directory", async () => {
    const daemon = fakeDaemon({ createWorkspace: vi.fn(async (_options: Record<string, unknown>) => ({
      workspaceId: "wks-new", agent: { id: "agent-branch" }, error: null,
    })) });
    const handlers = await register(hostWith(daemon));
    const result = await handlers.get("fork.create")!({ ...input, target: "new-workspace" });
    expect(result).toEqual({ agentId: "agent-branch", workspaceId: "wks-new", error: null });
    expect(daemon.createAgent).not.toHaveBeenCalled();
    const options = daemon.createWorkspace.mock.calls[0]![0];
    expect(options.source).toEqual({ kind: "directory", path: "/workspace" });
    const agentOptions = options.agent as Record<string, unknown>;
    expect(agentOptions.attachments).toEqual([{ type: "text", mimeType: "text/plain", contextKind: "chat_history", text: "HISTORY" }]);
    expect(agentOptions.initialPrompt).toBe(input.text);
    expect((agentOptions.config as Record<string, unknown>).model).toBe("sol");
  });

  it("surfaces a refused new-workspace create", async () => {
    const daemon = fakeDaemon({ createWorkspace: vi.fn(async () => ({
      workspaceId: null, agent: null, error: "Directory not found.",
    })) });
    const handlers = await register(hostWith(daemon));
    expect(await handlers.get("fork.create")!({ ...input, target: "new-workspace" }))
      .toEqual({ agentId: null, workspaceId: null, error: "Directory not found." });
  });

  it("surfaces the daemon's refusal when no history comes back", async () => {
    const daemon = fakeDaemon({ buildAgentForkContext: async () => ({
      requestId: "r", agentId: "agent-a", attachment: null, itemCount: 0,
      boundaryMessageId: null, error: "Unknown agent.",
    }) });
    const handlers = await register(hostWith(daemon));
    const result = await handlers.get("fork.create")!(input);
    expect(result).toEqual({ agentId: null, workspaceId: null, error: "Unknown agent." });
    expect(daemon.createAgent).not.toHaveBeenCalled();
    expect(daemon.close).toHaveBeenCalledTimes(1);
  });

  it("reports a dead daemon and a failed create without throwing", async () => {
    const handlers = await register(hostWith(null));
    expect(await handlers.get("fork.create")!(input))
      .toEqual({ agentId: null, workspaceId: null, error: "Could not reach the Paseo daemon." });

    const broken = fakeDaemon({ createAgent: async () => { throw new Error("provider offline"); } });
    const brokenHandlers = await register(hostWith(broken));
    expect(await brokenHandlers.get("fork.create")!(input))
      .toEqual({ agentId: null, workspaceId: null, error: "provider offline" });
  });

  it("rejects a malformed agent ID before connecting", async () => {
    const daemon = fakeDaemon();
    const handlers = await register(hostWith(daemon));
    expect(await handlers.get("fork.create")!({ ...input, agentId: "../etc" }))
      .toEqual({ agentId: null, workspaceId: null, error: "Invalid agent ID." });
    expect(daemon.buildAgentForkContext).not.toHaveBeenCalled();
  });

  it("refuses a turn without any boundary", async () => {
    const daemon = fakeDaemon();
    const handlers = await register(hostWith(daemon));
    expect(await handlers.get("fork.create")!({ ...input, boundary: null, messageId: null }))
      .toEqual({ agentId: null, workspaceId: null, error: "The turn has no fork boundary." });
    expect(daemon.buildAgentForkContext).not.toHaveBeenCalled();
  });
});
