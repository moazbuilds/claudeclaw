# Slack Adapter

Implementation-ready scaffold for a future Slack adapter.

**Status:** Documentation/scaffolding only — no working implementation  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## ⚠️ Important Notice

This directory contains **documentation and scaffolding only**. There is no working Slack adapter implementation. This scaffold exists to guide future implementation work.

---

## Overview

Slack is a workplace messaging platform with rich API support for bots. This scaffold documents the architecture, configuration, and implementation considerations for a future Slack adapter.

### Key Characteristics

- **Platform:** Slack (slack.com)
- **Inbound Modes:** Events API (webhook) or Socket Mode (WebSocket)
- **Threading:** Native via `thread_ts` parameter
- **Auth:** OAuth 2.0 + Bot User OAuth Token
- **Rate Limits:** Tiered by method (approx 100+ RPM for most)

---

## Environment Variables

```bash
# Required: Bot User OAuth Token (starts with xoxb-)
SLACK_BOT_TOKEN=xoxb-your-bot-token

# Required for Events API: Signing secret for webhook validation
SLACK_SIGNING_SECRET=your-signing-secret

# Required for Events API: Public webhook URL
SLACK_WEBHOOK_URL=https://your-domain.com/webhooks/slack

# Optional: Use Socket Mode instead of Events API
SLACK_USE_SOCKET_MODE=true

# Optional: App-Level Token for Socket Mode (starts with xapp-)
SLACK_APP_TOKEN=xapp-your-app-token

# Optional: Request verification token (legacy, prefer signing secret)
# SLACK_VERIFICATION_TOKEN=your-verification-token

# Optional: Default channel for notifications (channel ID or #name)
# SLACK_DEFAULT_CHANNEL=#general

# Optional: Enable debug logging
# SLACK_DEBUG=true
```

---

## App Setup Steps

### 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App"
3. Choose "From scratch"
4. Name your app (e.g., "ClaudeClaw")
5. Select your workspace (development workspace recommended)

### 2. Configure Bot Token Scopes

Navigate to **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**:

Required scopes:
- `app_mentions:read` — Read mention events
- `channels:history` — Read public channel messages
- `channels:join` — Join public channels
- `chat:write` — Send messages
- `chat:write.public` — Send messages to channels without joining
- `groups:history` — Read private channel messages (if needed)
- `groups:write` — Manage private channels (if needed)
- `im:history` — Read DM history
- `im:write` — Send DMs
- `mpim:history` — Read group DM history
- `mpim:write` — Send group DMs
- `users:read` — Read user info

### 3. Choose Inbound Mode

#### Option A: Events API (Recommended for Production)

1. Enable **Event Subscriptions**
2. Set Request URL to your public webhook endpoint
3. Subscribe to bot events:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`

**Requires:** Public HTTPS endpoint, valid SSL certificate

#### Option B: Socket Mode (Recommended for Development)

1. Go to **Socket Mode**
2. Enable Socket Mode
3. Generate an **App-Level Token** with `connections:write` scope
4. Event subscriptions still required but delivered via WebSocket

**Advantages:** No public URL needed, works behind NAT/firewall  
**Disadvantages:** Slightly higher latency, connection management complexity

### 4. Install to Workspace

1. Go to **OAuth & Permissions**
2. Click **Install to Workspace**
3. Authorize the requested scopes
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 5. Get Signing Secret

1. Go to **Basic Information**
2. Copy **Signing Secret** under **App Credentials**
3. Used to verify webhook signatures

---

## Auth Model

Slack uses OAuth 2.0 with bot tokens:

### Bot User OAuth Token
- Format: `xoxb-...`
- Lifetime: Long-lived (no expiration)
- Scope: Determined by requested bot scopes
- Storage: Treat as secret (environment variable)

### App-Level Token (Socket Mode only)
- Format: `xapp-...`
- Lifetime: Long-lived
- Scope: `connections:write` for Socket Mode
- Storage: Treat as secret

### Webhook Signature Validation

All webhook requests include signature headers:

```
X-Slack-Signature: v0=...
X-Slack-Request-Timestamp: 1234567890
```

Validation algorithm:
1. Extract timestamp from `X-Slack-Request-Timestamp`
2. Reject if timestamp > 5 minutes old (replay protection)
3. Create basestring: `v0:timestamp:body`
4. Compute HMAC-SHA256 with signing secret
5. Compare to signature (constant-time comparison)

```typescript
// Pseudocode for signature validation
function validateSlackSignature(
  body: string,
  signature: string,
  timestamp: string,
  signingSecret: string
): boolean {
  // Replay protection
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false;
  }
  
  const basestring = `v0:${timestamp}:${body}`;
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(basestring)
    .digest('hex');
  
  return timingSafeEqual(`v0=${expected}`, signature);
}
```

---

## Threading Model

Slack threading is based on `thread_ts` (thread timestamp):

### Concepts

- **Message:** Has a unique `ts` (timestamp) acting as message ID
- **Thread:** A parent message with replies
- **`thread_ts`:** Timestamp of parent message; included in all replies

### Inbound Thread Detection

```json
{
  "type": "message",
  "channel": "C123456",
  "ts": "1234567890.123456",
  "thread_ts": "1234567890.000000",  // Present if in thread
  "text": "Reply in thread"
}
```

- If `thread_ts` present: message is in a thread
- `thread_ts` === `ts`: message is thread parent
- No `thread_ts`: message is top-level (not in thread)

### Outbound Thread Reply

To reply in a thread:

```typescript
await slack.chat.postMessage({
  channel: channelId,
  thread_ts: threadTimestamp,  // Parent message ts
  text: "Reply text"
});
```

### Channel vs DM Behavior

| Type | channel ID prefix | Notes |
|------|-------------------|-------|
| Public channel | `C` | Anyone can join, visible |
| Private channel | `G` | Invite-only |
| DM | `D` | 1:1 direct message |
| Group DM | `G` | Multi-person DM |

---

## Inbound Mode Options

### Events API (HTTP Webhook)

**Pros:**
- Stateless (no persistent connection)
- Works with serverless
- Official production recommendation

**Cons:**
- Requires public HTTPS endpoint
- Must handle retries/deduplication

**Implementation notes:**
- Respond with 200 OK within 3 seconds
- Async processing after acknowledging
- Handle URL verification challenge on setup

### Socket Mode (WebSocket)

**Pros:**
- No public endpoint needed
- Works behind firewall/NAT
- Real-time delivery

**Cons:**
- Must manage WebSocket connection lifecycle
- Reconnection logic required
- Slightly higher latency

**Implementation notes:**
- Connect to `wss://wss-primary.slack.com/link/`
- Handle hello, reconnect, disconnect events
- Automatic reconnect with exponential backoff

---

## Outbound Reply Semantics

### Sending Messages

```typescript
// Simple text message
await slack.chat.postMessage({
  channel: "C123456",
  text: "Hello from ClaudeClaw"
});

// Reply in thread
await slack.chat.postMessage({
  channel: "C123456",
  thread_ts: "1234567890.000000",
  text: "Thread reply"
});

// With blocks (rich formatting)
await slack.chat.postMessage({
  channel: "C123456",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Bold* and _italic_ text"
      }
    }
  ]
});
```

### Updating Messages

```typescript
await slack.chat.update({
  channel: "C123456",
  ts: "1234567890.123456",
  text: "Updated text"
});
```

### Deleting Messages

```typescript
await slack.chat.delete({
  channel: "C123456",
  ts: "1234567890.123456"
});
```

---

## Normalization Mapping

Mapping Slack events to `NormalizedEvent`:

| NormalizedEvent | Slack Source |
|-----------------|--------------|
| `channel` | `"slack"` |
| `sourceEventId` | `event.ts` |
| `channelId` | `event.channel` with prefix: `slack:${team_id}:${channel}` |
| `threadId` | `event.thread_ts` or `"default"` |
| `userId` | `event.user` |
| `text` | `event.text` |
| `metadata.replyTo` | N/A (use thread_ts for reply context) |
| `metadata.command` | Extract from `text` if starts with `/` |

---

## Testing Approach

### Local Development

1. Use **Socket Mode** (no public URL needed)
2. Create test Slack workspace (free)
3. Set `SLACK_DEBUG=true` for verbose logging

### Webhook Testing (Events API)

1. Use ngrok for public tunnel:
   ```bash
   ngrok http 3000
   ```
2. Update Slack app webhook URL to ngrok URL
3. Verify signature validation works end-to-end

### Unit Testing

Mock areas:
- Webhook signature validation
- API responses (chat.postMessage)
- Event payload parsing

### Integration Testing

Test scenarios:
- App mention triggers response
- Thread reply maintains context
- DM conversation works
- File attachment handling
- Rate limit handling

---

## Rate Limit Considerations

Slack uses tiered rate limits:

| Tier | Requests per minute | Typical methods |
|------|---------------------|-----------------|
| Tier 1 | 1+ | Large data queries |
| Tier 2 | 20+ | Most write operations |
| Tier 3 | 50+ | Most read operations |
| Tier 4 | 100+ | Special cases |

**Headers provided:**
- `X-RateLimit-Limit`: Allowed requests
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Unix timestamp when limit resets
- `Retry-After`: Seconds to wait (on 429)

**Best practices:**
- Respect `Retry-After` header
- Implement exponential backoff
- Queue outbound messages during rate limit

---

## Open Investigation Questions

- [ ] **Enterprise Grid:** How do shared channels work across workspaces?
- [ ] **Workflow Steps:** Should we support Slack Workflow step from app?
- [ ] **Block Kit Complexity:** How much rich formatting should we support?
- [ ] **Shortcuts:** Should we implement message/global shortcuts?
- [ ] **Home Tab:** Should we implement App Home surface?
- [ ] **Enterprise Key Management:** EKM compliance requirements?

---

## Implementation Readiness Checklist

Before implementing this adapter:

- [ ] Slack app created in test workspace
- [ ] Bot token obtained and secured
- [ ] Signing secret obtained and secured
- [ ] Inbound mode chosen (Events API vs Socket Mode)
- [ ] Required scopes determined and configured
- [ ] Public webhook endpoint available (if Events API)
- [ ] Socket Mode token obtained (if Socket Mode)
- [ ] Rate limit handling strategy defined
- [ ] Test workspace with channels and users set up

---

## See Also

- [Slack API Documentation](https://api.slack.com/)
- [Slack Bolt Framework](https://slack.dev/bolt/)
- [Events API Reference](https://api.slack.com/events)
- [Socket Mode Guide](https://api.slack.com/apis/connections/socket)
- [`../README.md`](../README.md) — Adapter architecture overview
- [`../contracts.md`](../contracts.md) — Capability matrix
- [`../configuration.md`](../configuration.md) — Configuration patterns
