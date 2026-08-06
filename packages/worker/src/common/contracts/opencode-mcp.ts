export type OpenCodeMcpServerConfig =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string> | undefined;
      enabled?: boolean | undefined;
      timeout?: number | undefined;
    }
  | {
      type: "remote";
      url: string;
      enabled?: boolean | undefined;
      headers?: Record<string, string> | undefined;
      oauth?:
        | {
            clientId?: string | undefined;
            clientSecret?: string | undefined;
            scope?: string | undefined;
            redirectUri?: string | undefined;
          }
        | false
        | undefined;
      timeout?: number | undefined;
    }
  | {
      enabled: boolean;
    };

export type OpenCodeMcpServers = Record<string, OpenCodeMcpServerConfig>;
