// Environment-driven daemon configuration.

export interface AwceConfig {
  readonly wsUrl: string;
  readonly executorId: string;
  readonly executorToken: string;
  readonly agentBin: string;
  readonly agentModel: string | undefined;
  readonly workspaceRoot: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AwceConfig {
  const previous = process.env;
  process.env = env as NodeJS.ProcessEnv;
  try {
    const logLevel = optional('AWCE_LOG_LEVEL');
    return {
      wsUrl: required('AWCE_WS_URL').replace(/\/+$/, ''),
      executorId: required('AWCE_EXECUTOR_ID'),
      executorToken: required('AWCE_EXECUTOR_TOKEN'),
      agentBin: optional('AWCE_AGENT_BIN')
        ?? 'node::default', // resolved by runner against known Claude Code installs
      agentModel: optional('AWCE_AGENT_MODEL'),
      workspaceRoot: optional('AWCE_WORKSPACE_ROOT') ?? `${process.env.HOME ?? '.'}/.awce/capsules`,
      logLevel: logLevel === 'debug' || logLevel === 'warn' || logLevel === 'error' ? logLevel : 'info',
    };
  } finally {
    process.env = previous;
  }
}

/** WS endpoint with auth query params (token travels in the URL per protocol §3). */
export function authenticatedWsUrl(config: AwceConfig): string {
  return `${config.wsUrl}?executorId=${encodeURIComponent(config.executorId)}&token=${encodeURIComponent(config.executorToken)}`;
}

/** HTTP base derived from the WS URL, for frame-provided relative paths. */
export function httpBase(config: AwceConfig): string {
  return config.wsUrl
    .replace(/^ws:/, 'http://')
    .replace(/^wss:/, 'https://')
    .replace(/\/ws\/executor$/, '');
}
