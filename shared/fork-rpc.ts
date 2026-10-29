import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Fork a completed turn into a new agent of the same workspace.
 *
 * The host's own Fork works on a draft: the daemon's `agent.fork_context`
 * RPC turns the timeline up to the turn's final reply into a chat-history
 * attachment, the composer holds it until the reader sends the first
 * message, and only then does `create_agent_request` carry both. A plugin
 * can hold neither the draft nor the composer, so this RPC does the two
 * daemon calls back to back instead: build the attachment pinned to the
 * turn, then create the agent with it and the reader's first message as
 * one prompt — the same blocks the host's draft submission produces.
 *
 * The plugin server reaches the daemon through its own packages
 * (`server/tasks/provider-subagents.ts`), so the calls speak the daemon's
 * protocol version. Unavailable where those packages do not resolve; the
 * client hides the trigger then.
 */
export const forkSourceSchema = z.object({
  provider: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  modeId: z.string().nullable(),
  featureValues: z.record(z.string(), z.unknown()).nullable(),
  workspaceId: z.string().nullable(),
  /** The source agent's title, kept as the fork's own title. */
  title: z.string().nullable(),
});
export type ForkSource = z.output<typeof forkSourceSchema>;

export const forkCreateRpc = defineRpc({
  name: "fork.create",
  input: z.object({
    agentId: z.string().min(1),
    /** The final reply's timeline position; null with only a message ID. */
    boundary: z.object({ epoch: z.string(), seq: z.number() }).nullable(),
    messageId: z.string().nullable(),
    /** The forked conversation's first message; required, like the host's draft. */
    text: z.string().trim().min(1).max(32_000),
    /**
     * Where the fork lands: a new agent of the source's workspace, or a new
     * workspace created around the source directory (the host menu's two
     * targets). Absent means the workspace.
     */
    target: z.enum(["workspace", "new-workspace"]).optional(),
    source: forkSourceSchema,
  }),
  output: z.object({
    agentId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
