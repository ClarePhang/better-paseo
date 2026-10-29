import type { PluginServerContext } from "@getpaseo/plugin/server";
import { forkCreateRpc } from "../../shared/fork-rpc";
import { connectHostDaemon, hasHostDaemon } from "../tasks/provider-subagents";

/**
 * The daemon round-trips behind `fork.create`: the fork context reads the
 * turn's whole timeline, and the create resolves the provider's draft
 * config. The host's own fork allows the context fifteen seconds; creation
 * gets longer, since a provider snapshot may need fetching.
 */
const FORK_CONTEXT_TIMEOUT_MS = 15_000;
const FORK_CREATE_TIMEOUT_MS = 30_000;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The chat-history attachment the daemon's fork context returns and a create takes. */
interface HistoryAttachment {
  type: "text";
  mimeType: "text/plain";
  contextKind?: string;
  title?: string | null;
  text: string;
}

/**
 * The daemon calls behind a fork, as this server uses them — structural,
 * like every `connectHostDaemon` consumer: the connected client is the
 * daemon's own DaemonClient, whose protocol this plugin (0.13+) supports.
 */
export interface ForkDaemon {
  buildAgentForkContext(agentId: string, options?: {
    boundaryCursor?: { epoch: string; seq: number };
    boundaryMessageId?: string;
    requestId?: string;
  }): Promise<{
    attachment: HistoryAttachment | null;
    itemCount: number;
    boundaryMessageId: string | null;
    boundaryCursor?: { epoch: string; seq: number } | null;
    error: string | null;
  }>;
  createAgent(options: {
    provider: string;
    cwd: string;
    workspaceId?: string;
    config?: {
      provider: string;
      cwd: string;
      model?: string;
      thinkingOptionId?: string;
      modeId?: string;
      featureValues?: Record<string, unknown>;
    };
    attachments?: HistoryAttachment[];
    initialPrompt?: string;
  }): Promise<{ id: string }>;
  /** Creates a workspace around a directory and its first agent in one call. */
  createWorkspace(options: {
    source: { kind: "directory"; path: string };
    agent?: {
      config?: {
        provider: string;
        cwd: string;
        model?: string;
        thinkingOptionId?: string;
        modeId?: string;
        featureValues?: Record<string, unknown>;
      };
      attachments?: HistoryAttachment[];
      initialPrompt?: string;
    };
  }): Promise<{ workspaceId: string | null; agent: { id: string } | null; error: string | null }>;
  close(): Promise<void>;
}

/** How the server reaches this host's daemon; tests pass their own. */
export interface ForkHostAccess {
  available(): boolean;
  connect(): Promise<ForkDaemon | null>;
}

const hostDaemon: ForkHostAccess = {
  available: hasHostDaemon,
  connect: async () => {
    const daemon = await connectHostDaemon();
    return daemon as ForkDaemon | null;
  },
};

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Builds the turn's chat-history attachment, then creates the fork with it
 * and the reader's first message as one prompt — the two daemon calls the
 * host's draft submission would make, back to back. The attachment arrives
 * with its `contextKind` already set by the daemon and travels unchanged.
 * `target` lands the fork as a new agent of the source's workspace, or as
 * the first agent of a new workspace created around the source directory.
 */
export async function forkTurn(host: ForkHostAccess, input: {
  agentId: string;
  boundary: { epoch: string; seq: number } | null;
  messageId: string | null;
  text: string;
  target?: "workspace" | "new-workspace";
  source: {
    provider: string;
    cwd: string;
    model: string | null;
    thinkingOptionId: string | null;
    modeId: string | null;
    featureValues: Record<string, unknown> | null;
    workspaceId: string | null;
    title: string | null;
  };
}): Promise<{ agentId: string | null; workspaceId: string | null; error: string | null }> {
  if (!AGENT_ID_PATTERN.test(input.agentId)) return { agentId: null, workspaceId: null, error: "Invalid agent ID." };
  if (!input.boundary && !input.messageId) return { agentId: null, workspaceId: null, error: "The turn has no fork boundary." };
  const daemon = await host.connect();
  if (!daemon) return { agentId: null, workspaceId: null, error: "Could not reach the Paseo daemon." };
  try {
    const context = await withTimeout(
      daemon.buildAgentForkContext(input.agentId, {
        ...(input.boundary ? { boundaryCursor: input.boundary } : {}),
        ...(input.messageId ? { boundaryMessageId: input.messageId } : {}),
      }),
      FORK_CONTEXT_TIMEOUT_MS, "The daemon did not answer the fork context request.",
    );
    if (!context.attachment) {
      return { agentId: null, workspaceId: null, error: context.error || "The daemon returned no chat history for this turn." };
    }
    const { source } = input;
    const config = {
      provider: source.provider,
      cwd: source.cwd,
      ...(source.title ? { title: source.title } : {}),
      ...(source.model ? { model: source.model } : {}),
      ...(source.thinkingOptionId ? { thinkingOptionId: source.thinkingOptionId } : {}),
      ...(source.modeId ? { modeId: source.modeId } : {}),
      ...(source.featureValues ? { featureValues: source.featureValues } : {}),
    };
    if (input.target === "new-workspace") {
      const created = await withTimeout(
        daemon.createWorkspace({
          source: { kind: "directory", path: source.cwd },
          agent: { config, attachments: [context.attachment], initialPrompt: input.text },
        }),
        FORK_CREATE_TIMEOUT_MS, "The daemon did not answer the fork create request.",
      );
      if (created.error || !created.agent) {
        return { agentId: null, workspaceId: null, error: created.error || "The daemon created no forked agent." };
      }
      return { agentId: created.agent.id, workspaceId: created.workspaceId ?? null, error: null };
    }
    const agent = await withTimeout(
      daemon.createAgent({
        provider: source.provider,
        cwd: source.cwd,
        workspaceId: source.workspaceId ?? undefined,
        config,
        attachments: [context.attachment],
        initialPrompt: input.text,
      }),
      FORK_CREATE_TIMEOUT_MS, "The daemon did not answer the fork create request.",
    );
    return { agentId: agent.id, workspaceId: source.workspaceId, error: null };
  } catch (error) {
    return { agentId: null, workspaceId: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await daemon.close().catch(() => {});
  }
}

export function registerForkServer(server: PluginServerContext, host: ForkHostAccess = hostDaemon): void {
  server.handle(forkCreateRpc, (input) => forkTurn(host, input));
}
