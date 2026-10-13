import {
  formatMessage,
  MemoryAdapterRegistry,
  type Actor,
  type AgentAdapter,
  type ArtifactRef,
  type ChannelComment,
  type ChannelRef,
  type DeliveryReceipt,
  type Message,
  type MessageHeaders,
  type OutboundEnvelope,
} from "../src/index.js";

export const APP_SLUG = "llm-messageboard";
export const SELF_LOGIN = `${APP_SLUG}[bot]`;
export const CHANNEL: ChannelRef = { owner: "acme", repo: "widgets", issue: 42 };
export const BASE_THREAD = "acme/widgets#42";

export function actor(login = "octocat", type: Actor["type"] = "User"): Actor {
  return { login, type };
}

export function headers(
  overrides: Partial<MessageHeaders> = {},
): MessageHeaders {
  return {
    from: "HERMES",
    to: "INSTINCT",
    kind: "MSG",
    hop: 0,
    extra: {},
    ...overrides,
  };
}

interface MessageOverrides {
  headers?: Partial<MessageHeaders>;
  body?: string;
  artifacts?: readonly ArtifactRef[];
}

export function message(overrides: MessageOverrides = {}): Message {
  return {
    headers: headers(overrides.headers),
    body: overrides.body ?? "ping",
    artifacts: overrides.artifacts ?? [],
  };
}

interface CommentOverrides {
  id?: string;
  author?: Actor;
}

/** A comment whose body is the serialised form of `m`. */
export function commentFrom(
  m: Message,
  overrides: CommentOverrides = {},
): ChannelComment {
  return {
    id: overrides.id ?? "1001",
    body: formatMessage(m),
    author: overrides.author ?? actor(),
    createdAt: "2026-01-01T00:00:00Z",
  };
}

export function rawComment(
  body: string,
  overrides: CommentOverrides = {},
): ChannelComment {
  return {
    id: overrides.id ?? "1001",
    body,
    author: overrides.author ?? actor(),
    createdAt: "2026-01-01T00:00:00Z",
  };
}

export type StubAdapter = AgentAdapter & { received: OutboundEnvelope[] };

export function stubAdapter(
  agent: string,
  options: { transport?: AgentAdapter["transport"]; online?: boolean } = {},
): StubAdapter {
  const received: OutboundEnvelope[] = [];
  return {
    agent,
    transport: options.transport ?? "outbound",
    online: options.online ?? true,
    received,
    async deliver(envelope: OutboundEnvelope): Promise<DeliveryReceipt> {
      received.push(envelope);
      return { accepted: true, agent, commentId: "9001" };
    },
  };
}

export function registryOf(...agents: string[]): MemoryAdapterRegistry {
  const registry = new MemoryAdapterRegistry();
  for (const agent of agents) registry.register(stubAdapter(agent));
  return registry;
}
