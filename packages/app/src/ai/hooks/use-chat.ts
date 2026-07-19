import type { ChatContext } from "@/hooks/use-chat-state";
import { resolveChatContextAtSend } from "@/lib/chat-context";
import {
  type UIMessage,
  type UseChatOptions,
  useChat as useChatSDK,
} from "@ai-sdk/react";
import type { ChatInit, LanguageModel } from "ai";
import { useEffect, useRef } from "react";
import { CustomChatTransport } from "../custom-chat-transport";

type CustomChatOptions = Omit<ChatInit<UIMessage>, "transport"> &
  Pick<UseChatOptions<UIMessage>, "experimental_throttle" | "resume"> & {
    chatContext?: ChatContext;
    getLiveChatContext?: () => ChatContext;
  };

export function useChat(model: LanguageModel, options?: CustomChatOptions) {
  const { chatContext, getLiveChatContext, ...restOptions } = options || {};
  const chatContextRef = useRef(chatContext);
  const liveChatContextRef = useRef(getLiveChatContext);
  const transportRef = useRef<CustomChatTransport | null>(null);

  // Keep both sources synchronous with the latest render. The live resolver
  // reads the reader store again at the transport boundary.
  chatContextRef.current = chatContext;
  liveChatContextRef.current = getLiveChatContext;

  if (!transportRef.current) {
    transportRef.current = new CustomChatTransport(model, {
      prepareSendMessagesRequest: ({ body }) => {
        const currentChatContext = resolveChatContextAtSend(
          chatContextRef.current,
          liveChatContextRef.current
        );
        return {
          body: {
            ...body,
            chatContext: currentChatContext,
          },
        };
      },
    });
  }

  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.updateModel(model);
    }
  }, [model]);

  const chatResult = useChatSDK({
    transport: transportRef.current,
    ...restOptions,
  });

  return chatResult;
}
