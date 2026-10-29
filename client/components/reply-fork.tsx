import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { unselectable } from "./selection";
import { radiusV2, space, type ExtendedThemeTokens } from "./theme-tokens";
import { CenteredToolbarDetails, ToolbarItem } from "../ui/toolbar-button";
import { useFooterDetailsWidth } from "./footer-details";
import { DISCLOSURE_HEADER } from "../ui/disclosure-header";
import { TYPE } from "../ui/tokens/typography";
import { forkCreateRpc } from "../../shared/fork-rpc";
import type { ForkSource } from "../../shared/fork-rpc";
import { toolbarLabel } from "../i18n/toolbar-strings";
import type { SettingsLanguagePreference } from "../i18n/settings-strings";

/**
 * The plugin's own Fork for a completed turn, shown where the host's
 * `ForkMenu` is absent (every released host; `getpaseo/paseo#7462`). Like the
 * host's fork: press, pick where the fork lands — a new agent of this
 * workspace, or a new workspace around this agent's directory — and the fork
 * happens at once; the reader types afterwards, in the new conversation. The
 * daemon starts a created agent's prompt at once, so the history cannot wait
 * in a composer the way a host draft holds it: the fork's first turn carries
 * the imported conversation plus a standby note, and the model's one-word
 * acknowledgement closes it.
 */

export interface ReplyForkRequest {
  agentId: string;
  boundary: { epoch: string; seq: number } | null;
  messageId: string | null;
  source: ForkSource;
}

/** The first message of a forked conversation: history plus a standby note. */
function standbyMessage(language: SettingsLanguagePreference): string {
  return toolbarLabel(
    "The messages above are the previous conversation, attached for context. Do not act on them; wait for my next message. Reply with exactly: Ready.",
    language,
  );
}

const TARGETS = [
  { key: "workspace", label: "Fork (this workspace)" },
  { key: "new-workspace", label: "Fork to a new workspace" },
] as const;

type ForkTarget = (typeof TARGETS)[number]["key"];

export function ReplyForkSheet({ request, tokens, compact, language }: {
  request: ReplyForkRequest;
  tokens: ExtendedThemeTokens;
  compact: boolean;
  language: SettingsLanguagePreference;
}) {
  const rpc = useRpc(forkCreateRpc);
  const toast = useToast();
  const detailsWidth = useFooterDetailsWidth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const fork = useCallback((target: ForkTarget) => {
    setOpen(false);
    setPending(true);
    void rpc({
      agentId: request.agentId,
      boundary: request.boundary,
      messageId: request.messageId,
      text: standbyMessage(language),
      target,
      source: request.source,
    }).then((result) => {
      if (!mounted.current) return;
      setPending(false);
      if (result.error || !result.agentId) {
        toast.error(result.error || "The fork failed.");
        return;
      }
      toast.show(toolbarLabel(target === "new-workspace"
        ? "Forked — the new agent is in its own new workspace"
        : "Forked — the new agent is in this workspace", language));
    }, (cause) => {
      if (!mounted.current) return;
      setPending(false);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, request, pending, toast, language]);

  const styles = useMemo(
    () => StyleSheet.create({
      trigger: {
        width: "auto",
        marginHorizontal: -space.xs,
        height: 24,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        paddingHorizontal: space.xs,
        borderRadius: radiusV2.block,
      },
      triggerLabel: {
        fontFamily: tokens.fontUi,
        fontSize: TYPE.button.size,
        lineHeight: TYPE.button.lineHeight,
        color: tokens.foregroundMuted,
        ...unselectable,
      },
      menu: { gap: space.xs, paddingBottom: space.xs },
      menuItem: {
        width: "auto",
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        minHeight: 28,
        paddingHorizontal: space.xs,
        marginHorizontal: -space.xs,
        borderRadius: radiusV2.block,
      },
      menuItemLabel: {
        fontFamily: tokens.fontUi,
        fontSize: TYPE.button.size,
        lineHeight: TYPE.button.lineHeight,
        color: tokens.foreground,
        ...unselectable,
      },
    }),
    [tokens],
  );

  const canFork = Boolean(request.boundary || request.messageId);
  if (!canFork) return null;

  return <>
    <ToolbarItem
      label={pending ? toolbarLabel("Forking…", language) : toolbarLabel("Fork this turn", language)}
      accessibilityLabel={pending ? "Forking…" : "Fork this turn"}
      tokens={tokens}
      align="start"
      buttonStyle={styles.trigger}
      onPress={() => setOpen(true)}
      hitSlop={compact ? 10 : 0}
    >
      <Icon name="GitBranch" size={DISCLOSURE_HEADER.icon} color={tokens.foregroundMuted} />
      <Text style={styles.triggerLabel}>
        {toolbarLabel(pending ? "Forking…" : "Fork", language)}
      </Text>
    </ToolbarItem>
    {open ? (
      <CenteredToolbarDetails close={() => setOpen(false)} width={detailsWidth} tokens={tokens}>
        <View style={styles.menu}>
          {TARGETS.map((option) => (
            <ToolbarItem key={option.key}
              label={toolbarLabel(option.label, language)}
              accessibilityLabel={option.label}
              tokens={tokens} align="start" buttonStyle={styles.menuItem}
              onPress={() => fork(option.key)}>
              <Icon name={option.key === "workspace" ? "SquareSplitHorizontal" : "SquarePlus"}
                size={DISCLOSURE_HEADER.icon} color={tokens.foregroundMuted} />
              <Text style={styles.menuItemLabel}>{toolbarLabel(option.label, language)}</Text>
            </ToolbarItem>
          ))}
        </View>
      </CenteredToolbarDetails>
    ) : null}
  </>;
}
