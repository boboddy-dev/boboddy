/**
 * The OpenCode v2 config document Boboddy emits as `OPENCODE_CONFIG_CONTENT`,
 * taken from `@opencode/client`'s generated `ConfigEntry` so the overlay
 * follows the pinned runtime's schema instead of a hand-written copy.
 */
import type { ConfigEntry, PermissionRule } from "@opencode/client";

export type OpenCodeOverlayConfig = Extract<
  ConfigEntry,
  { type: "document" }
>["info"];

export type OpenCodePermissionRule = PermissionRule;

export type OpenCodeOverlayAgent = NonNullable<
  OpenCodeOverlayConfig["agents"]
>[string];

export type OpenCodeOverlayMcpServer = NonNullable<
  NonNullable<OpenCodeOverlayConfig["mcp"]>["servers"]
>[string];
