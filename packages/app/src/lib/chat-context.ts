import type { ChatContext } from "@/hooks/use-chat-state";

/**
 * Resolves chat context at the transport boundary. Reader callers provide a
 * live resolver backed by the per-book Zustand store so a relocation that
 * happened after the last React render still wins over the rendered snapshot.
 */
export function resolveChatContextAtSend(
  renderedContext: ChatContext | undefined,
  getLiveContext?: () => ChatContext,
): ChatContext | undefined {
  return getLiveContext?.() ?? renderedContext;
}
