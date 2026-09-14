import type { BillingClass } from './accounts.js';

export type ProviderKey = 'claude' | 'codex' | 'cursor' | 'gemini' | 'glm' | 'openrouter' | 'kimi' | 'deepseek' | 'grok' | 'nvidia' | 'perplexity' | 'meta' | 'opencode' | 'groq' | 'cerebras' | 'mistral' | 'qwen' | 'copilot' | 'amazonq' | 'ollama' | 'lmstudio';

export type HarnessStyle = 'native-claude' | 'native-codex' | 'native-cursor' | 'browser-oauth' | 'anthropic-compat' | 'openai-compat' | 'local-runtime';

export interface ProviderMatrixEntry {
  key: ProviderKey;
  displayName: string;
  envRepoint: boolean;
  harnessStyle: HarnessStyle;
  credentialEnvVars: string[];
  probe: string;
  billingClass: BillingClass[];
  trainsOnInputs: boolean;
  oneLoginAtATime: boolean;
  usageSource: 'vendor-meter' | 'bookkeeping-only' | 'none';
  wizardDefault: boolean;
  blocked?: { reason: string };
}

export const PROVIDER_MATRIX: Record<ProviderKey, ProviderMatrixEntry> = {
  claude: {
    key: 'claude', displayName: 'Claude', envRepoint: false, harnessStyle: 'native-claude', credentialEnvVars: [],
    probe: 'claude auth status --json', billingClass: ['subscription-quota'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  codex: {
    key: 'codex', displayName: 'Codex', envRepoint: false, harnessStyle: 'native-codex', credentialEnvVars: [],
    probe: 'codex login status', billingClass: ['subscription-quota'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  cursor: {
    key: 'cursor', displayName: 'Cursor', envRepoint: false, harnessStyle: 'native-cursor', credentialEnvVars: [],
    probe: 'cursor-agent status --format json', billingClass: ['subscription-quota'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  gemini: {
    key: 'gemini', displayName: 'Gemini/Antigravity', envRepoint: false, harnessStyle: 'browser-oauth', credentialEnvVars: [],
    probe: 'agy -p', billingClass: ['subscription-quota'], trainsOnInputs: false,
    oneLoginAtATime: true, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  glm: {
    key: 'glm', displayName: 'GLM', envRepoint: true, harnessStyle: 'anthropic-compat',
    credentialEnvVars: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'BIGMODEL_API_KEY'],
    probe: 'POST /chat/completions', billingClass: ['subscription-quota'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  openrouter: {
    key: 'openrouter', displayName: 'OpenRouter', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['OPENROUTER_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'GET /api/v1/key', billingClass: ['prepaid-credit', 'free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  kimi: {
    key: 'kimi', displayName: 'Kimi', envRepoint: true, harnessStyle: 'anthropic-compat',
    credentialEnvVars: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
    probe: 'GET /v1/users/me/balance', billingClass: ['pay-per-token', 'prepaid-credit'], trainsOnInputs: true,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  deepseek: {
    key: 'deepseek', displayName: 'DeepSeek', envRepoint: true, harnessStyle: 'anthropic-compat',
    credentialEnvVars: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'GET /models or balance', billingClass: ['prepaid-credit', 'pay-per-token'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  grok: {
    key: 'grok', displayName: 'Grok/xAI', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['XAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'GET /v1/models', billingClass: ['prepaid-credit', 'pay-per-token'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: true,
  },
  nvidia: {
    key: 'nvidia', displayName: 'NVIDIA Build', envRepoint: true, harnessStyle: 'openai-compat', credentialEnvVars: ['NVIDIA_API_KEY'],
    probe: 'GET /v1/models', billingClass: ['free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'none', wizardDefault: false,
    blocked: { reason: 'Account creation currently fails for many users because of SMS verification failures at signup.' },
  },
  perplexity: {
    key: 'perplexity', displayName: 'Perplexity', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['PERPLEXITY_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'cheap chat completion', billingClass: ['prepaid-credit'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  meta: {
    key: 'meta', displayName: 'Muse/Meta', envRepoint: true, harnessStyle: 'openai-compat', credentialEnvVars: ['MODEL_API_KEY'],
    probe: 'GET /v1/models', billingClass: ['pay-per-token'], trainsOnInputs: true,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: false,
    blocked: { reason: 'Paid-only API has no free tier and the operator decision between Muse and third-party Llama remains open.' },
  },
  opencode: {
    key: 'opencode', displayName: 'OpenCode', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_*', 'CLOUDFLARE_*'],
    probe: 'auth list / models', billingClass: ['free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: false,
  },
  groq: {
    key: 'groq', displayName: 'Groq', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['GROQ_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'GET /openai/v1/models', billingClass: ['free-tier', 'prepaid-credit', 'pay-per-token'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: false,
  },
  cerebras: {
    key: 'cerebras', displayName: 'Cerebras', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['CEREBRAS_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'GET /v1/models', billingClass: ['free-tier', 'pay-per-token'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'vendor-meter', wizardDefault: false,
  },
  mistral: {
    key: 'mistral', displayName: 'Mistral', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['MISTRAL_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'GET /v1/models', billingClass: ['free-tier', 'pay-per-token', 'prepaid-credit'], trainsOnInputs: true,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  qwen: {
    key: 'qwen', displayName: 'Qwen', envRepoint: true, harnessStyle: 'openai-compat',
    credentialEnvVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: '1-token qwen-turbo', billingClass: ['pay-per-token', 'prepaid-credit', 'free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  copilot: {
    key: 'copilot', displayName: 'GitHub Copilot', envRepoint: false, harnessStyle: 'browser-oauth', credentialEnvVars: [],
    probe: 'gh auth; copilot', billingClass: ['subscription-flat', 'free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  amazonq: {
    key: 'amazonq', displayName: 'Amazon Q Developer (CLI)', envRepoint: false, harnessStyle: 'browser-oauth', credentialEnvVars: [],
    probe: 'q whoami; q doctor', billingClass: ['subscription-flat', 'free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'bookkeeping-only', wizardDefault: true,
  },
  ollama: {
    key: 'ollama', displayName: 'Ollama', envRepoint: true, harnessStyle: 'local-runtime',
    credentialEnvVars: ['OLLAMA_HOST', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'tags/models/list', billingClass: ['free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'none', wizardDefault: true,
  },
  lmstudio: {
    key: 'lmstudio', displayName: 'LM Studio', envRepoint: true, harnessStyle: 'local-runtime',
    credentialEnvVars: ['LM_API_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    probe: 'models/lms ps', billingClass: ['free-tier'], trainsOnInputs: false,
    oneLoginAtATime: false, usageSource: 'none', wizardDefault: true,
  },
};

export const getProvider = (key: string): ProviderMatrixEntry | undefined => PROVIDER_MATRIX[key as ProviderKey];

export const listEnvRepointProviders = (): ProviderMatrixEntry[] =>
  Object.values(PROVIDER_MATRIX).filter((provider) => provider.envRepoint);

export const listWizardProviders = (): ProviderMatrixEntry[] =>
  Object.values(PROVIDER_MATRIX).filter((provider) => provider.wizardDefault);
