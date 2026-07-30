export type PiProviderApi = "openai-completions";

export type PiThinkingFormat = "deepseek" | "qwen-chat-template";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiModelCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

export type PiModelDefinition = {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly thinkingFormat?: PiThinkingFormat;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: PiModelCost;
};

export type PiProviderDefinition = {
  readonly id: string;
  readonly baseUrl: string;
  readonly api?: PiProviderApi;
  readonly apiKey?: string;
  readonly compat?: {
    readonly supportsDeveloperRole?: boolean;
    readonly supportsReasoningEffort?: boolean;
  };
  readonly models: readonly PiModelDefinition[];
};

export type PiExtensionDefinition = {
  readonly path: string;
  readonly appendSystemPrompt?: string;
};

export type PiBuildCommand = {
  readonly command: readonly string[];
  readonly platforms?: readonly PiPlatform[];
};

export type PiPlatform = "linux" | "macos" | "windows";

export type PiAppDefinition = {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly rootDir?: string;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly piCommand: string;
  readonly providers: readonly PiProviderDefinition[];
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly thinking: PiThinkingLevel;
  readonly tools?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompts?: readonly string[];
  readonly extensions?: readonly PiExtensionDefinition[];
  readonly env?: Readonly<Record<string, string>>;
  readonly forwardedArgs?: readonly string[];
  readonly build?: readonly PiBuildCommand[];
};

export type PiAppManifest = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly schema_version: number;
  readonly description?: string;
  readonly platforms?: readonly PiPlatform[];
  readonly state_dir: string;
  readonly session_dir?: string;
  readonly pi_command?: string;
  readonly thinking?: PiThinkingLevel;
  readonly tools?: readonly string[];
  readonly system_prompt?: string;
  readonly provider: {
    readonly id: string;
    readonly base_url: string;
    readonly api?: PiProviderApi;
  };
  readonly model: {
    readonly id: string;
    readonly name?: string;
    readonly context_window?: number;
    readonly max_tokens?: number;
    readonly reasoning?: boolean;
    readonly thinking_format?: PiThinkingFormat;
  };
  readonly env?: Readonly<Record<string, string>>;
  readonly extensions?: readonly {
    readonly path: string;
    readonly append_system_prompt?: string;
  }[];
  readonly build?: readonly PiBuildCommand[];
};

export type PiRuntimeConfigPaths = {
  readonly configDir: string;
  readonly modelsPath: string;
  readonly settingsPath: string;
};

export type PiRuntimeConfig = PiRuntimeConfigPaths;

export type PiRunMode = "interactive" | "print" | "json" | "rpc";

export type PiLaunchOverrides = {
  readonly cwd?: string;
  readonly mode?: PiRunMode;
  readonly session?: string;
  readonly name?: string;
  readonly messages?: readonly string[];
};

export type PiLaunchPlan = {
  readonly appId: string;
  readonly appName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly runtimeConfig: PiRuntimeConfigPaths;
  readonly manifestPath?: string;
  readonly warnings: readonly string[];
};

export type InstalledPiApp = {
  readonly appId: string;
  readonly name: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly appRoot: string;
  readonly enabled: boolean;
  readonly source: PiAppSourceInfo;
  readonly installedUnixMs?: number;
  readonly warnings?: readonly string[];
};

export type PiAppSourceInfo =
  | { readonly kind: "local" }
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly subdir?: string;
      readonly requestedRef?: string;
      readonly resolvedCommit?: string;
      readonly managedPath?: string;
    };
