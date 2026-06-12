/**
 * MCP host constants — mirroring the PROXY_* constants in
 * local-devcontainer-port-forward-manager-support.ts.
 */
export const MCP_HOST_DIRECTORY_PATH = "/tmp/boboddy-mcp-host";
export const MCP_HOST_BINARY_PATH = `${MCP_HOST_DIRECTORY_PATH}/boboddy-mcp-host`;
export const MCP_HOST_PLUGINS_JSON_PATH = `${MCP_HOST_DIRECTORY_PATH}/plugins.json`;
export const MCP_HOST_LOG_PATH = `${MCP_HOST_DIRECTORY_PATH}/mcp-host.log`;
export const MCP_HOST_PID_PATH = `${MCP_HOST_DIRECTORY_PATH}/mcp-host.pid`;

/**
 * How long to wait (ms) after launching the MCP host before checking liveness.
 * Longer than PROXY_BOOT_WAIT_MS because the host needs to install npm packages.
 */
export const MCP_HOST_BOOT_WAIT_MS = 2_000;

/**
 * Liveness probe timeout (ms) — total time to wait for /health to return 200.
 */
export const MCP_HOST_HEALTH_TIMEOUT_MS = 120_000;

/**
 * Liveness probe poll interval (ms).
 */
export const MCP_HOST_HEALTH_POLL_MS = 1_000;

/**
 * Port search range for the MCP host listener port.
 * Picked from a range distinct from the proxy port range (39000–65535)
 * to avoid collisions. We just pick from the same range but after
 * the proxy manager — in practice ephemeral allocation handles this.
 */
export const MCP_HOST_PORT_SEARCH_START = 39_000;
export const MCP_HOST_PORT_SEARCH_END = 65_535;
