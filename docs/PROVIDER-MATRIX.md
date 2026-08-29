# Provider auth + usage matrix (HED-432)

Account-authentication and usage matrix for the heddle onboarding wizard, doctor, reporter, and
per-dispatch credential isolation.
Every column is per account; a user may add many accounts per provider where its documentation permits.
Verified against the raw official-doc research rows on 2026-08-28.
Groq and Cerebras are supplementary / not wizard-default; OpenCode is the harness row; Ollama and LM
Studio are the local-runtime class.

## Summary table

| Provider | Auth mechanism | Env-repoint<br>class? | Credential shape | Where obtained |
|---|---|---|---|---|
| GLM | API key | YES | 32 hex`.`16 alnum | undocumented; env guidance |
| OpenRouter | API key / OAuth PKCE | YES | `sk-or-v1-…` | key creation / auth page |
| Kimi | API key | YES | API key | undocumented console surface |
| DeepSeek | API key | YES | single string | undocumented |
| Grok/xAI | API key | YES | `xai-…` | console.x.ai |
| NVIDIA Build | API key | YES | `nvapi-…` | Build dashboard |
| Perplexity | API key | YES | alphanumeric | undocumented console surface |
| Muse/Meta | API key | YES | `LLM|{id}|{secret}` | dev.meta.ai |
| Claude | CLI OAuth/setup token | no | OAuth/setup token | `claude auth login`/`setup-token` |
| Codex | CLI OAuth/API key | no | OAuth/API key | `codex login` |
| Gemini/Antigravity | browser OAuth | no | keyring token | `agy login` |
| Cursor | browser OAuth/User API Key | no | OAuth/key | `agent login` / dashboard |
| OpenCode | keys/provider OAuth | YES | auth JSON/env | `opencode auth login` |
| Groq | API key | YES | `gsk_` + 48 alnum | console.groq.com |
| Cerebras | API key | YES | `csk-…` | console |
| Mistral | API key | YES | random string | developer console, **not Le Chat** |
| Qwen | API key | YES | `sk-…` / `sk-sp-…` | Model Studio developer console, **not chat** |
| GitHub Copilot | device OAuth/PAT | no | OAuth/PAT | `/login`, `gh auth login`, PAT settings |
| Amazon Q Developer (CLI) | device OAuth | no | SSO session | `q login` |
| Ollama | none | YES | URL/model | local runtime |
| LM Studio | none/optional token | YES | URL/token/model | local runtime |

| Provider | Validation-at-add probe | Usage source | Billing class | Lowest tier / free value | Multi-account posture |
|---|---|---|---|---|---|
| GLM | `POST /chat/completions` | vendor-meter quota | subscription-quota | Lite; promo tokens | undocumented |
| OpenRouter | `GET /api/v1/key` | vendor-meter | prepaid-credit/free-tier | 50 RPD, 20 RPM | per-key labels/limits |
| Kimi | `GET /v1/users/me/balance` | vendor-meter | pay-per-token/prepaid | $1 recharge | undocumented |
| DeepSeek | `GET /models` or balance | vendor-meter | prepaid/pay-per-token | undocumented | undocumented |
| Grok/xAI | `GET /v1/models` | vendor-meter | prepaid/pay-per-token | no free API credits | undocumented |
| NVIDIA Build | `GET /v1/models` | none | free-tier/enterprise | 1,000 credits | undocumented |
| Perplexity | cheap chat completion | bookkeeping-only | prepaid-credit | no free credits | undocumented |
| Muse/Meta | `GET /v1/models` | bookkeeping-only | pay-per-token | no free tier | undocumented |
| Claude | `claude auth status --json` | vendor-meter | subscription-quota | Pro | `CLAUDE_CONFIG_DIR` |
| Codex | `codex login status` | vendor-meter | subscription-quota | Free/Go restricted | `CODEX_HOME` |
| Gemini/Antigravity | `agy -p` | bookkeeping-only | subscription-quota | Free throttled | one login at a time |
| Cursor | `cursor-agent status --format json` | bookkeeping-only | subscription-quota | Hobby | per-run key env |
| OpenCode | `auth list` / models | bookkeeping-only | undocumented | undocumented | auth store/env |
| Groq | `GET /openai/v1/models` | vendor-meter | free/prepaid/token | card-less free | org shared limits |
| Cerebras | `GET /v1/models` | vendor-meter | free/pay-per-token | card-less free | undocumented |
| Mistral | `GET /v1/models` | bookkeeping-only | free/token/prepaid | Experiment | workspace/free per org |
| Qwen | 1-token `qwen-turbo` | bookkeeping-only | token/prepaid/free | 1M tokens/model | workspace/region |
| GitHub Copilot | `gh auth`; `copilot` | bookkeeping-only | flat/free | 2,000 + 50/mo | existing-accounts-only |
| Amazon Q Developer (CLI) | `q whoami`; `q doctor` | bookkeeping-only | flat/free | 50 requests/mo | undocumented |
| Ollama | tags/models/list | none | local-free | no quota | no account |
| LM Studio | models/`lms ps` | none | local-free | no quota | no account |

## Cross-cutting rules

1. **Env-repoint isolation:** GLM uses `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`,
   `OPENAI_BASE_URL`/`OPENAI_API_KEY`, or `BIGMODEL_API_KEY`; Kimi uses the Anthropic pair and
   `ANTHROPIC_MODEL` family; DeepSeek uses the Anthropic pair or OpenAI vars; xAI, Perplexity,
   Groq, Cerebras, Mistral, Qwen, and local OpenAI-compatible runtimes use named key plus OpenAI
   base/key; NVIDIA uses `NVIDIA_API_KEY`; Meta `MODEL_API_KEY`; Qwen also `DASHSCOPE_API_KEY` or
   `QWEN_API_KEY`; OpenCode reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `CLOUDFLARE_*`.
   Inject them only into that dispatch worker environment: never shared settings, dotfiles, or
   global `.env`; provider A workers never see provider B credentials.
   [GLM](https://api.z.ai/api/coding/paas/v4) [Kimi](https://api.moonshot.ai/anthropic)
   [OpenRouter](https://openrouter.ai/api/v1)
2. **Validation at add:** `doctor` immediately runs the cheapest probe above, retaining only result
   and error data. Env-repoint accounts use their provider endpoint, not native CLI login status.
3. **Storage:** use registry/keychain credential references, never a loose file. Display-once keys
   are captured at input and never redisplayed.
4. **Usage windows:** vendor-meter means a MACHINE-READABLE documented key/balance/quota endpoint or
   CLI JSON that the reporter can poll: GLM quota endpoint (5-hour and weekly); OpenRouter key
   endpoint (daily/weekly/monthly with reset); Kimi and DeepSeek balance; Claude 5-hour and weekly
   (the usage tap); Codex plan limits (`wham/usage`, unofficial but working); Groq/Cerebras response
   headers. Antigravity (interactive TUI `/usage` only) and Copilot (browser billing page only) are
   **bookkeeping-only** until a headless capture path is specified — the reporter records dispatch
   usage and points at the console; `none` has no vendor meter.
5. **Expiry/rotation:** 401 is invalid/revoked/expired or re-login; DeepSeek/OpenRouter 402 is
   insufficient/exhausted balance; GLM 429 is expected at quota; NVIDIA 403 is missing scope;
   Cursor 429 is exhaustion; Antigravity is `RESOURCE_EXHAUSTED`. OpenRouter 429 can be upstream.
6. **Privacy:** set `trainsOnInputs`: true for Kimi, Mistral free/Experiment unless opted out, and
   Meta `*-contributor`; wizard warns before proprietary code is routed.
   [Kimi](https://api.moonshot.ai/v1)

## Per-provider details

### GLM

1. Auth/API: key; regional [CN](https://open.bigmodel.cn/api/coding/paas/v4) or
   [global](https://api.z.ai/api/coding/paas/v4) base. 2. Shape: 32 hex`.`16 alnum, never `sk-`.
3. Env: Anthropic/OpenAI repoint or `BIGMODEL_API_KEY`; high global-bleed risk. 4. Probe: minimal
`POST /chat/completions` → 200. 5. Store: env/secrets manager, no loose file. 6. Meter:
[quota](https://bigmodel.cn/api/monitor/usage/quota/limit), 5-hour rolling + weekly. 7. Billing:
subscription-quota Lite/Pro/Max; token fall-through undocumented. 8. Lowest: Lite/promo tokens.
9. Expiry: no fixed expiry; 401, console rotation. 10. Risks: region/path and model-config errors.

- Wizard prompts:
  - “China or global region?”
  - “Paste GLM key and select plan/model.”

Free-tier value / per-account limits / multi-account posture: promotional registration tokens (1–3
months), 5-hour and weekly limits; multi-account posture undocumented.

### OpenRouter

1. Auth: Bearer key or [OAuth PKCE](https://openrouter.ai/auth). 2. Shape: `sk-or-v1-…`.
3. API: [OpenAI base](https://openrouter.ai/api/v1); global repoint is high risk. 4. Probe:
`GET /api/v1/key`. 5. Storage: write-only creation, per-key labels/spend limit. 6. Meter: key usage;
[credits](https://openrouter.ai/api/v1/credits) needs Management Key; generation `usage.cost`.
7. Billing: prepaid + free; 402 unless opt-in auto-top-up. 8. Lowest: free models. 9. Expiry:
indefinite unless `expires_at`; 401 revoked. 10. Risks: negative balance blocks free; 429 upstream.

- Wizard prompts:
  - “Paste key or complete OAuth PKCE.”
  - “Optional site URL/title and optional Management Key?”

Free-tier value / per-account limits / multi-account posture: 20 RPM/50 RPD without $10 purchase, or
20 RPM/1,000 RPD with; per-key labels/limits; account credits need Management Key.

### Kimi

1. Auth: API key/native Kimi CLI. 2. API: [Anthropic](https://api.moonshot.ai/anthropic) or
[OpenAI](https://api.moonshot.ai/v1) compatibility. 3. Env: Anthropic base/token/model family;
high bleed. 4. Probe: `GET /v1/users/me/balance` or models. 5. Store: secret manager/keychain.
6. Meter: available/voucher/cash balance and recharge tiers. 7. Billing: pay-per-token/prepaid,
consumer membership separate. 8. Lowest: $1 recharge, $5 voucher after $5. 9. Expiry: revoked/401;
zero hard-block. 10. Privacy: inputs/generated code optimize models; code models may require thinking.

- Wizard prompts:
  - “Paste Moonshot key and select model/thinking.”
  - “This trains on inputs; continue only for permitted code?”

Free-tier value / per-account limits / multi-account posture: $1 minimum recharge and tiered limits;
multi-account posture is undocumented, but the training warning applies to every account.

### DeepSeek

1. Auth/API: key at [DeepSeek](https://api.deepseek.com), OpenAI base or `/anthropic`.
2. Shape: single string. 3. Env: `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` or OpenAI vars; high bleed.
4. Probe: `GET /models` or `/user/balance`. 5. Storage: undocumented. 6. Meter: available and
total/granted/topped-up balances; 429 concurrency. 7. Billing: prepaid/pay-per-token, 402 at zero.
8. Lowest: trial undocumented. 9. Expiry/rotation: undocumented; 401 auth failure. 10. Risk:
unsupported Anthropic names silently map; select explicit model.

- Wizard prompts:
  - “Paste DeepSeek key; OpenAI or Anthropic-compatible endpoint?”
  - “Select an explicit DeepSeek model.”

Free-tier value / per-account limits / multi-account posture: trial/free allowance, key lifecycle, and
multi-account posture undocumented; concurrency limits apply.

### Grok/xAI

1. Auth: `xai-…` key from console.x.ai. 2. API: OpenAI `/v1`, Anthropic-compatible root.
3. Env: `XAI_API_KEY`; OpenAI repoint has moderate bleed. 4. Probe: `GET /v1/models`.
5. Store: env reference/keychain. 6. Meter: response usage, console/Management API (separate key).
7. Billing: prepaid/pay-per-token, enterprise invoiced, $0 hard-stop. 8. Lowest: none.
9. Expiry: no auto-expiry; 401/manual rotation. 10. Consumer X Premium/SuperGrok is not API access.

- Wizard prompts:
  - “Paste xAI API key; OpenAI or Anthropic endpoint?”
  - “Optional separate Management Key for usage?”

Free-tier value / per-account limits / multi-account posture: no free API credits; spend-tier limits;
multi-account posture undocumented.

### NVIDIA Build

1. Auth: `nvapi-…` key, optional TTL/scope. 2. API: `https://integrate.api.nvidia.com/v1`.
3. Env: `NVIDIA_API_KEY`; low bleed. 4. Probe: `GET /v1/models`. 5. Store: display-once, keychain.
6. Meter: no documented usage API. 7. Billing: free hard-stop or enterprise/self-host NIM.
8. Lowest: 1,000 credits, request up to 5,000. 9. Expiry: TTL 1h-never; 401 expired, 403 scope.
10. SMS failures use [help@build.nvidia.com](mailto:help@build.nvidia.com).

- Wizard prompts:
  - “Paste display-once key; does it have Public API Endpoints scope?”
  - “If SMS failed, contact the documented support address.”

Free-tier value / per-account limits / multi-account posture: 1,000 credits, requestable to 5,000,
and approximately 40 RPM observed; multi-account posture undocumented.

### Perplexity

1. Auth: display-once alphanumeric key. 2. API: catalog `/router/v1`, search agent `/v1/agent`.
3. Env: `PERPLEXITY_API_KEY`; global OpenAI base is high bleed. 4. Probe: cheap router completion.
5. Store: env reference/secret manager. 6. Meter: dashboard; Analytics API is Enterprise-only.
7. Billing: prepaid $1 credits; optional auto-top-up, otherwise hard stop. 8. Lowest: no free credits.
9. Expiry: no auto-expiry; 401/manual console rotation. 10. Consumer Pro/Max is not API credit.

- Wizard prompts:
  - “Paste API key; catalog or search-agent endpoint?”
  - “Confirm this is API credit, not a Pro/Max plan.”

Free-tier value / per-account limits / multi-account posture: no free credits; spend-based rate tiers;
multi-account posture undocumented.

### Muse/Meta

1. Muse API is Meta's proprietary family at [dev.meta.ai](https://dev.meta.ai). 2. API:
`https://api.meta.ai/v1`; old Llama API retired. 3. Shape/env: display-once `LLM|{id}|{secret}` and
`MODEL_API_KEY`. 4. Probe: `GET /v1/models`. 5. Store: secrets manager. 6. Meter: dashboard only.
7. Billing: card-required pay-per-token, high silent-overage risk. 8. Lowest: no free tier.
9. Expiry: manual rotation; expiry undocumented. 10. Contributor models train on prompts.

- Wizard prompts:
  - “Paid Meta Model API, or third-party-hosted open Llama?”
  - “Paste Meta key; permit contributor models that train prompts?”

Free-tier value / per-account limits / multi-account posture: no free tier and card required;
per-account limits and multi-account posture undocumented.

### Claude

1. Auth: `claude auth login` or `claude setup-token`/`CLAUDE_CODE_OAUTH_TOKEN`. 2. Plans:
Pro/Max/Team/Enterprise. 3. Isolation: `CLAUDE_CONFIG_DIR` per account relocates config/sessions
and, on Linux/Windows, credentials; on macOS credentials live in the Keychain and per-config-dir
Keychain isolation is UNVERIFIED (LANDMINES) — the wizard uses `claude setup-token` →
`CLAUDE_CODE_OAUTH_TOKEN` per account there, or gates on a verification test; never `--bare` (forces
API-key billing). 4. `ANTHROPIC_API_KEY` silently switches to API billing. 5. Probe: `claude auth
status --json`. 6. Store: config/keychain. 7. Meter: `/usage-credits` and ring. 8. Billing:
subscription quota, optional credits. 9. Windows: 5-hour + weekly; re-login on failure. 10.
Exhaustion: `API Error: Rate limit reached`.

- Wizard prompts:
  - “Complete CLI login in isolated CLAUDE_CONFIG_DIR, or use setup token?”
  - “Which subscription account/plan?”

Free-tier value / per-account limits / multi-account posture: Claude Pro is lowest documented
headless-capable tier; 5-hour/weekly limits; isolate each account by `CLAUDE_CONFIG_DIR`
(Linux/Windows) or a per-account setup token (macOS, until Keychain isolation is verified).

### Codex

1. Auth: `codex login`, optional `--device-auth`, or headless token. 2. Plans: Free through
Enterprise. 3. Isolation: one `CODEX_HOME` per account (auth/config/session history) — and NEVER two
concurrent workers under the same `CODEX_HOME` (openai/codex#35619: catastrophic rollout-history
loss): same-account dispatches serialize, or each worker gets its own state directory. 4. API-key
login overrides subscription. 5. Probe: `codex login status` (stderr). 6. Store:
`$CODEX_HOME/auth.json`. 7. Meter: `/status` and `/statusline`. 8. Billing: plan quota shared
web/desktop/CLI. 9. Tokens refresh actively; logout/login rotates. 10. Headless rate-limit string
undocumented.

- Wizard prompts:
  - “Complete device login in a new isolated CODEX_HOME.”
  - “Subscription auth or API-key login; which plan/account?”

Free-tier value / per-account limits / multi-account posture: ChatGPT Free/Go works with restricted
limits; exact allowance undocumented; use distinct `CODEX_HOME` per account and serialize workers
that share one.

### Gemini/Antigravity

1. Auth: browser OAuth via `agy login`, no API keys/BYOK. 2. Plans: Free/AI Pro/AI Ultra.
3. Store: OS keyring. 4. Native posture: one login at a time. 5. Probe: `agy -p`.
6. Meter: TUI `/usage`. 7. Windows: roughly 250 units/5h and 2,800/week. 8. Billing: quota;
AI-credit fallback optional. 9. Expiry: auth-required/timeout, interactive login. 10. ToS forbid
third-party software login use; official binary only.

- Wizard prompts:
  - “Open browser login for this Google account?”
  - “Replace the one currently logged-in account?”
  - “Allow optional AI-credit fallback?”

Free-tier value / per-account limits / multi-account posture: Free works with aggressive throttling;
about 250/5h and 2,800/week; one-login-at-a-time with no documented per-account switch.

### Cursor

1. Auth: browser login (`agent login`) is the supported path; a dashboard User API Key via
`CURSOR_API_KEY` (env only — `--api-key` on argv leaks via `ps`) is an account selector whose
billing-to-plan is UNDOCUMENTED (LANDMINES, SPEC): the wizard must not mint rotation keys until one
test job is confirmed on the plan dashboard. 2. Plans: Hobby/Pro/Pro+/Ultra/Teams. 3. Isolation:
per-run key env, only after that billing test passes; browser-login switching is manual and global.
4. Probe: `cursor-agent status --format json`. 5. Store: dashboard key/env reference. 6. Meter:
Spending dashboard; CLI tokens not dollars. 7. Teams API offers filtered events. 8. Billing: monthly
pool then optional on-demand. 9. Key lasts until revoked; 429 exhaustion. 10. CLI does not support
BYOK provider keys.

- Wizard prompts:
  - “Browser login (default), or a User API Key — only after the plan-billing verification step?”
  - “Which plan/billing account; is on-demand enabled?”

Free-tier value / per-account limits / multi-account posture: Hobby works headless with strict
limits; monthly pool resets per billing cycle; distinct per-run keys can select accounts once plan
billing is verified; until then browser login only.

### OpenCode

1. Harness row, not wizard-default provider. 2. Auth: `opencode auth login`, provider keys/OAuth. 3.
Includes Zen/Go and consumer paths. 4. Shape: JSON auth store/env. 5. Probe: `auth list`/models. 6.
Store: OpenCode’s own auth JSON/config; a project `.env` is an upstream HAZARD (read greedily,
commit-able), never heddle storage — heddle credentials stay in the registry/keychain with
per-dispatch injection. 7. Meter: stats/JSON events. 8. Billing: undocumented. 9. Headless
exit/stdin behavior undocumented. 10. Greedy env reads and Anthropic subscription wrapping ToS
require sandboxing; Claude plugins removed v1.3.0.

- Wizard prompts:
  - “Which upstream credential should this adapter use?”
  - “Confirm this worker receives no other provider credentials.”

Free-tier value / per-account limits / multi-account posture: undocumented; multiple auth records are
technically representable, but provider ToS and cross-credential bleed are risks.

### Groq

1. Supplementary/not-default. 2. Auth: `gsk_` + 48 alnum key. 3. API/env:
`https://api.groq.com/openai/v1`, `GROQ_API_KEY`, env-repoint. 4. Probe: `GET /openai/v1/models`.
5. Store: secret manager/.env source guidance; not shared env. 6. Meter: headers and
[console](https://console.groq.com). 7. Billing: free/prepaid/pay-per-token. 8. Lowest: card-less
free. 9. Expiry: indefinite; 401; [keys](https://console.groq.com/keys). 10. Free 429s and org
limits are shared across keys.

- Wizard prompts:
  - “Paste Groq key; supplementary provider—add it anyway?”
  - “Is Balance Maintenance/auto-recharge enabled?”

Free-tier value / per-account limits / multi-account posture: card-less free with strict model
RPM/RPD/TPM/TPD; org-level limits share across keys; multi-email value undocumented.

### Cerebras

1. Supplementary/not-default. 2. Auth: `csk-…`. 3. API/env: `https://api.cerebras.ai/v1`,
`CEREBRAS_API_KEY`, env-repoint. 4. Probe: `GET /v1/models`. 5. Store: env/.env/secret manager source
guidance; not shared env. 6. Meter: request/token headers + console. 7. Billing: free/pay-token.
8. Lowest: card-less Free Trial. 9. Expiry: indefinite; 401; console rotation. 10. Dual TPM buckets;
`max_completion_tokens` counts before inference.

- Wizard prompts:
  - “Paste Cerebras key; supplementary provider—add it anyway?”
  - “Select model with request and dual-token limits in mind.”

Free-tier value / per-account limits / multi-account posture: card-less Free Trial with strict model
RPM/RPD/TPM/TPD; multi-account posture undocumented.

### Mistral

1. Obtain key from Mistral Studio/La Plateforme developer console, **not Le Chat**. 2. API:
`https://api.mistral.ai/v1`; env `MISTRAL_API_KEY`, env-repoint. 3. Shape: random workspace-scoped
string, optional expiry. 4. Probe: `GET /v1/models` (401 Invalid API Key). 5. Store: display-once vault.
6. Meter: console Usage/Admin API, spend tiers. 7. Billing: free Experiment/post-paid/prepaid.
8. Lowest: no-card Experiment. 9. Expiry date immutable; otherwise manual rotation. 10. Free-tier
data trains by default unless privacy opt-out.

- Wizard prompts:
  - “Use Mistral Studio/La Plateforme console, not Le Chat; paste key and workspace.”
  - “Has Experiment privacy opt-out been enabled?”

Free-tier value / per-account limits / multi-account posture: restrictive no-card Experiment; free is
per org and keys per workspace; multi-account feasibility beyond that is undocumented.

### Qwen

1. Obtain key from Model Studio developer console, **not Qwen chat app**. 2. `/auth` supports
Model Studio/third-party/custom. 3. Shapes: `sk-…` or `sk-sp-…`. 4. Env: DASHSCOPE/QWEN/OpenAI vars,
env-repoint. 5. Probe: 1-token `qwen-turbo` completion. 6. Store: settings/secret manager.
7. Meter: console Free Quota/Bill Details; no usage API. 8. Billing: token/prepaid/free; Free Quota
Only avoids silent overage. 9. Keys do not expire; free tokens expire 90 days. 10. Region/workspace
endpoints have data-residency implications.

- Wizard prompts:
  - “Open Model Studio console, not chat, and paste key.”
  - “Which region/workspace endpoint; enable Free Quota Only?”

Free-tier value / per-account limits / multi-account posture: 1,000,000 tokens/model for 90 days,
mainly Singapore; keys per workspace; region/data-residency flags apply.

### GitHub Copilot

1. Auth: OAuth device via `/login`/`gh auth login`, or PAT with Copilot Requests scope. 2. No
OpenAI-compatible endpoint. 3. Env: prefer `COPILOT_GITHUB_TOKEN` over GH/GITHUB tokens. 4. Probe:
`gh auth status`, minimal `copilot "test"`. 5. Store: env/keychain/gh config; plaintext fallback
risk. 6. Meter: [billing](https://github.com/settings/billing). 7. Free: 2,000 completions plus 50
premium/month. 8. Billing: flat/free; exhaustion degrades. 9. OAuth revoked/PAT TTL; 401 login. 10.
Org policy can block; signup pause is operator report, not official documentation.

- Wizard prompts:
  - “Use an existing entitled GitHub account; device OAuth or scoped PAT?”
  - “Is Copilot CLI enabled by organization policy?”

Free-tier value / per-account limits / multi-account posture: 2,000 completions + 50 premium monthly;
multi-account/signup policy undocumented; wizard is existing-accounts-only.

### Amazon Q Developer

**Two surfaces share the brand — the wizard must say so, or users go hunting for a phantom account.**

- **(a) The PR reviewer, `amazon-q-developer[bot]`, is a GitHub App** installed from the GitHub
  Marketplace onto the GitHub org/repo — the listing reads "Free with no AWS account required. By
  installing, you agree to the AWS Customer Agreement…". No AWS login exists behind it; it rides the
  GitHub installation. It is a review bot, NOT a heddle provider: heddle cannot dispatch to it and it
  never appears in the registry. (Fixture: an operator who had the bot reviewing PRs for months could
  not find "their Amazon Q account" — there was none.)
- **(b) The developer surface heddle would drive is a separate sign-up:** `q login` with an AWS
  Builder ID ("no AWS account required" — AWS docs) for the Free tier, or IAM Identity Center for
  Pro. A Builder ID is created fresh; it is not recovered from GitHub or from the bot. AWS Free Tier
  limits "apply … at the user level for AWS Builder ID users" (AWS pricing FAQ). AWS has announced end
  of support for the Amazon Q Developer IDE plugins on April 30, 2027 and points users to Kiro; Kiro
  CLI signs in with GitHub, Google, AWS Builder ID or IAM Identity Center (kiro.dev). Whether the `q`
  CLI itself is folded into Kiro CLI is unverified — see Open questions.

1. `q login`: Builder ID Free or IAM Identity Center Pro. 2. Auth: device code; headless key path
undocumented. 3. Shared AWS SSO cache/`AWS_PROFILE` can bleed. 4. Not env-repoint. 5. Probe:
`q whoami --format json`, `q doctor`. 6. Store: AWS SSO cache/Amazon Q config. 7. Free 50 requests/mo,
Pro 1,000; CLI visibility undocumented. 8. Billing: flat/free; Pro transformation $0.003/line.
9. SSO 8–12h admin-defined; interactive re-login. 10. Browser required; telemetry default on.

- Wizard prompts:
  - “Seen `amazon-q-developer[bot]` on your PRs? That is the GitHub App — it gives you no login here.”
  - “Builder ID Free (create one — no AWS account needed) or IAM Identity Center Pro?”
  - “For Pro, enter Start URL/Region and complete browser login.”

Free-tier value / per-account limits / multi-account posture: 50 agentic requests/month (Pro 1,000);
multi-account switching/limits undocumented; shared SSO cache can bleed.

### Ollama

1. Local runtime; no account. 2. API: `http://localhost:11434/v1`. 3. Shape: URL/model.
4. Env: `OLLAMA_HOST`, env-repoint; `0.0.0.0` exposes unauthenticated server. 5. Probe: tags/models/list.
6. Store: models under `~/.ollama/models`. 7. Meter: no quota; eval/duration response data.
8. Billing: local-free. 9. Limits: RAM and server-global `OLLAMA_NUM_PARALLEL`; restart to change.
10. Default `keep_alive` is five minutes.

- Wizard prompts:
  - “Enter local base URL/model; is server running and model pulled?”
  - “Confirm it is not network-exposed unauthenticated.”

Free-tier value / per-account limits / multi-account posture: local-free/no quota; RAM and parallelism
limit use; no accounts, so multi-email signups do not apply.

### LM Studio

1. Local runtime; optional `LM_API_TOKEN`. 2. API: `http://localhost:1234/v1`.
3. Shape: URL/token/model. 4. Env-repoint class; `--bind 0.0.0.0` exposes server.
5. Probe: models, `lms ps --json`, `lms ls --json`, or server status. 6. Store: app-data GGUF/MLX.
7. Meter: no quota; concurrency/RAM/VRAM. 8. Billing: local-free. 9. Limits: Max Concurrent
Predictions and JIT/idle unload. 10. Apple source: macOS 14+, M-series, 16 GB recommended.

- Wizard prompts:
  - “Enter local URL, optional token, and model.”
  - “Is `lms` on PATH; server/model/RAM/architecture verified?”

Free-tier value / per-account limits / multi-account posture: local-free/no quota; local model,
RAM/VRAM, and concurrency limit use; no accounts, so multi-email signups do not apply.

## Custom-provider template

Wizard asks for display name, API style (OpenAI-compatible / Anthropic-compatible / custom), base URL,
key environment-variable name, key value, model IDs, optional balance/usage endpoint, billing class,
and trains-on-inputs flag. Strictest-default isolation: treat every custom provider as env-repoint;
inject only its stated vars/base URL into one worker, never shared settings/dotfiles or another
provider's credential environment.

## Flags for other tickets

- **HED-395:** billing classes and environment allow-by-class, including env-repoint and `local-free`.
- **HED-396:** registry fields: `credentialRef`, `baseUrl`, `region`, `trainsOnInputs`,
  `oneLoginAtATime`, fences.
- **HED-400:** Amazon Q two-surface copy (the GitHub App reviewer is not a provider login);
  Copilot existing-accounts-only; NVIDIA support fallback; Qwen/Mistral console routing;
  Grok/Perplexity consumer-versus-API copy.
- **HED-401/HED-430:** vendor-meter: GLM quota, OpenRouter key, Kimi/DeepSeek balance, Claude tap,
  Codex. Perplexity, Meta, Cursor, OpenCode, Mistral, Qwen, Amazon Q, Antigravity (TUI-only) and
  Copilot (web-only) are bookkeeping-only.

## Open questions

- **OpenRouter**
  - Full-account credits require Management Key; ordinary keys report only per-key stats.
- **Grok/xAI**
  - Document `GET /v1/models` behavior for valid key with $0 balance; Management API is alternate probe.
- **Muse/Meta**
  - Operator decision: paid proprietary Muse API or free Llama via third-party hosts.
- **Gemini/Antigravity**
  - One-login-at-a-time is documented; no documented native per-account switch. Capture exact
  `agy -p --output-format stream-json` quota error.

- **Cursor**
  - Capture exact `cursor-agent -p --output-format json` quota error.
- **OpenCode**
  - Headless exit codes/stdin are undocumented; adapter requires isolation and Anthropic-ToS review.
- **Qwen**
  - Confirm free-quota regional availability beyond the mainly Singapore documented path.
- **Amazon Q Developer**
  - Headless non-interactive login and per-account switching are undocumented.
  - The relationship between the `q` CLI and Kiro CLI (rename vs. sibling) is unverified; verify
  before the wizard names a binary.
