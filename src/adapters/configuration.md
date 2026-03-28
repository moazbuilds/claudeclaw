# Adapter Configuration

Configuration patterns and implementation guidance for ClaudeClaw adapters.

**Status:** Documentation for current and future adapter configuration  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## Configuration Philosophy

Adapters follow these configuration principles:

1. **Environment variables for secrets** — No secrets in code or committed config files
2. **Explicit over implicit** — Each adapter declares what it needs
3. **Fail fast on missing config** — Clear errors at startup, not runtime
4. **Consistent naming** — `{ADAPTER}_{SETTING}` pattern
5. **Optional feature flags** — Enable/disable without code changes

---

## Environment Variable Patterns

### Naming Convention

```bash
{ADAPTER}_{SETTING}={value}
```

Examples:
- `TELEGRAM_BOT_TOKEN` — Telegram bot authentication
- `SLACK_SIGNING_SECRET` — Slack webhook validation
- `EMAIL_IMAP_HOST` — Email IMAP server hostname

### Common Setting Names

| Setting | Purpose | Example |
|---------|---------|---------|
| `_TOKEN` | API token or bot token | `xoxb-...`, `123456:ABC...` |
| `_SECRET` | Webhook signature secret | `whsec_...` |
| `_KEY` | API key or private key | `sk-...`, path to PEM |
| `_ID` | App/client ID | `123456`, `owner/repo` |
| `_URL` | Endpoint or webhook URL | `https://...` |
| `_HOST` | Server hostname | `imap.gmail.com` |
| `_PORT` | Server port | `993`, `587` |
| `_USER` | Username | `bot@example.com` |
| `_PASS` | Password or app password | (secret) |
| `_ENABLED` | Feature toggle | `true`, `false` |
| `_DEBUG` | Debug logging | `true`, `false` |

### Per-Adapter Configuration Examples

#### Telegram (Implemented)

```bash
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# Optional
TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhooks/telegram
TELEGRAM_DEBUG=false
```

#### Discord (Implemented)

```bash
# Required
DISCORD_BOT_TOKEN=MTAwMDAwMDAwMDAwMDAwMDAwMA.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Optional
DISCORD_INTENTS=GUILDS,GUILD_MESSAGES,DIRECT_MESSAGES
DISCORD_DEBUG=false
```

#### Slack (Scaffolded)

```bash
# Required for Events API
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret

# Required for Socket Mode
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_USE_SOCKET_MODE=true

# Optional
SLACK_WEBHOOK_URL=https://your-domain.com/webhooks/slack
SLACK_DEFAULT_CHANNEL=#general
SLACK_DEBUG=false
```

#### Teams (Scaffolded)

```bash
# Required
TEAMS_APP_ID=your-app-id
TEAMS_APP_PASSWORD=your-app-password

# Optional
TEAMS_WEBHOOK_URL=https://your-domain.com/webhooks/teams
TEAMS_TENANT_ID=your-tenant-id
TEAMS_DEBUG=false
```

#### Email (Scaffolded)

```bash
# Required (IMAP/SMTP)
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=claudeclaw@example.com
EMAIL_IMAP_PASS=your-app-password
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=claudeclaw@example.com
EMAIL_SMTP_PASS=your-app-password

# Optional
EMAIL_POLL_INTERVAL=60
EMAIL_MAX_SIZE=10485760
EMAIL_SUPPRESS_PATTERNS=noreply@,no-reply@
```

#### GitHub (Scaffolded)

```bash
# Required
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional
GITHUB_API_URL=https://api.github.com
GITHUB_ALLOWED_REPOS=owner/repo1,owner/repo2
GITHUB_DEBUG=false
```

---

## Secrets Handling

### Environment Variables (Recommended)

Secrets are read from environment variables at runtime:

```typescript
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}
```

### Local Development

Use `.env` files (not committed):

```bash
# .env.local — add to .gitignore!
TELEGRAM_BOT_TOKEN=your-token-here
SLACK_BOT_TOKEN=xoxb-your-token
```

Load with:
```typescript
import { loadEnv } from "./utils";
loadEnv(".env.local");
```

### Production Deployment

Options ranked by security:

1. **Secret management service** (best)
   - AWS Secrets Manager
   - Azure Key Vault
   - Google Secret Manager
   - HashiCorp Vault

2. **Container orchestration secrets**
   - Kubernetes secrets
   - Docker secrets
   - ECS secrets

3. **CI/CD injected**
   - GitHub Actions secrets
   - GitLab CI variables
   - CircleCI contexts

4. **Environment variables** (acceptable with caveats)
   - Visible in process list
   - May appear in logs
   - Use only for non-sensitive or ephemeral deployments

### Key Files

For private keys (GitHub App, etc.):

```bash
# Option 1: File path
GITHUB_APP_PRIVATE_KEY_PATH=/secure/keys/github-app.pem

# Option 2: Base64-encoded inline
GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ...
```

**File permissions:**
```bash
chmod 600 /secure/keys/github-app.pem
```

---

## Configuration Integration with Settings

Adapters can read from the centralized settings store:

### Settings Interface Extension

```typescript
// src/config.ts
interface Settings {
  // ... existing settings
  
  adapters?: {
    telegram?: {
      enabled: boolean;
      webhookUrl?: string;
    };
    discord?: {
      enabled: boolean;
      intents?: string[];
    };
    slack?: {
      enabled: boolean;
      useSocketMode?: boolean;
    };
    // ... other adapters
  };
}
```

### Adapter Enablement Pattern

```typescript
// Check if adapter is enabled
function isAdapterEnabled(adapterName: string): boolean {
  const settings = getSettings();
  
  // 1. Check settings file
  if (settings.adapters?.[adapterName]?.enabled !== undefined) {
    return settings.adapters[adapterName].enabled;
  }
  
  // 2. Check environment variable
  const envEnabled = process.env[`${adapterName.toUpperCase()}_ENABLED`];
  if (envEnabled !== undefined) {
    return envEnabled === 'true';
  }
  
  // 3. Check if required credentials exist
  const requiredToken = process.env[`${adapterName.toUpperCase()}_TOKEN`] 
    || process.env[`${adapterName.toUpperCase()}_BOT_TOKEN`];
  
  // Default: enabled if credentials exist
  return !!requiredToken;
}
```

---

## Public Webhook vs Socket/Polling Tradeoffs

### Decision Matrix

| Adapter | Webhook | Socket | Polling | Recommendation |
|---------|---------|--------|---------|----------------|
| Telegram | ✅ | ❌ | ❌ | Webhook (simple, reliable) |
| Discord | ❌ | ✅ | ❌ | WebSocket (required) |
| Slack | ✅ | ✅ | ❌ | Socket Mode (dev), Events API (prod) |
| Teams | ✅ | ❌ | ❌ | Webhook (only option) |
| Email | ❌ | ❌ | ✅ | IMAP polling (or Gmail API push) |
| GitHub | ✅ | ❌ | ❌ | Webhook (only option) |

### Webhook (HTTP Push)

**Pros:**
- Near real-time
- Efficient (no idle connections)
- Works with serverless

**Cons:**
- Requires public HTTPS endpoint
- Must handle retries
- Signature validation required

**Best for:** Production deployments with stable infrastructure

### Socket/WebSocket

**Pros:**
- Bi-directional
- Real-time
- Works behind NAT/firewall

**Cons:**
- Connection management complexity
- Reconnection logic required
- Resource intensive (persistent connections)

**Best for:** Development, environments without public URLs

### Polling

**Pros:**
- No public endpoint needed
- Simple to implement
- Works anywhere

**Cons:**
- Latency (polling interval)
- Inefficient (many empty checks)
- Rate limit pressure

**Best for:** Email, legacy systems, restricted environments

---

## Implementation Readiness Checklist

For each new adapter, verify:

### Configuration
- [ ] All required environment variables documented
- [ ] Validation logic for required config
- [ ] Sensible defaults for optional config
- [ ] Clear error messages for missing config
- [ ] Debug/logging toggle

### Security
- [ ] Webhook signature validation implemented
- [ ] Secrets not logged or exposed
- [ ] Token refresh logic (if applicable)
- [ ] Rate limit handling

### Integration
- [ ] Normalizer transforms platform events correctly
- [ ] Gateway submission follows event flow
- [ ] Outbound sending respects thread context
- [ ] Capability declaration accurate

### Testing
- [ ] Unit tests for normalization
- [ ] Integration tests with platform
- [ ] Webhook signature validation tests
- [ ] Error handling tests

### Documentation
- [ ] README with setup steps
- [ ] Environment variable reference
- [ ] Threading model explained
- [ ] Rate limits documented
- [ ] Known limitations noted

---

## Future Adapter Development Workflow

When implementing a new adapter:

1. **Review scaffold** — Start with the scaffold README in `src/adapters/{name}/`
2. **Configure environment** — Add required env vars to `.env.local`
3. **Implement normalizer** — Transform platform events to `NormalizedEvent`
4. **Implement auth** — Handle platform authentication
5. **Implement inbound** — Webhook, socket, or polling reception
6. **Implement outbound** — Send replies/messages
7. **Add capabilities** — Declare `AdapterCapabilities`
8. **Test end-to-end** — Verify gateway integration
9. **Update capability matrix** — Add to `contracts.md`
10. **Document** — Update scaffold README with implementation notes

---

## Example: Minimal Adapter Implementation Pattern

```typescript
// src/adapters/example/index.ts

import type { NormalizedEvent } from "../../gateway/normalizer";

interface ExampleConfig {
  token: string;
  webhookSecret?: string;
  debug?: boolean;
}

export class ExampleAdapter {
  name = "example";
  private config: ExampleConfig;
  private running = false;

  constructor(config: ExampleConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Validate config
    if (!this.config.token) {
      throw new Error("Example adapter: token is required");
    }
    // Setup API client
  }

  async start(): Promise<void> {
    // Start webhook listener or polling
    this.running = true;
  }

  async stop(): Promise<void> {
    // Graceful shutdown
    this.running = false;
  }

  getCapabilities() {
    return {
      supportsThreads: true,
      supportsDirectMessages: true,
      supportsChannelMessages: true,
      supportsAttachments: true,
      supportsWebhooks: true,
      authModel: "token" as const,
    };
  }

  normalizeInboundEvent(platformEvent: unknown): NormalizedEvent {
    // Transform to NormalizedEvent
    return {
      id: "",
      channel: "example",
      channelId: `example:${platformEvent.chat.id}`,
      threadId: platformEvent.threadId || "default",
      userId: String(platformEvent.user.id),
      text: platformEvent.text || "",
      attachments: [],
      timestamp: Date.now(),
      metadata: {},
    };
  }

  async sendMessage(
    target: { channelId?: string; threadId?: string },
    content: { text: string }
  ): Promise<{ success: boolean }> {
    // Send via platform API
    return { success: true };
  }
}
```

---

## See Also

- [`README.md`](./README.md) — Adapter architecture overview
- [`contracts.md`](./contracts.md) — Capability matrix and contracts
- `src/config.ts` — Centralized settings implementation
- Per-adapter READMEs in `slack/`, `teams/`, `email/`, `github/`
