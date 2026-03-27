# Phase 2: Session Gateway - Research

**Researched:** 2026-03-27
**Domain:** Session management, event normalization, gateway patterns
**Confidence:** HIGH

## Summary

Phase 2 requires building a gateway layer that decouples channel adapters (Telegram, Discord) from event processing and enables per-conversation session management. The current architecture uses a single global `session.json` shared across all channels, which causes interleaved conversations.

This research covers four key areas: (1) session mapping patterns for multi-tenant isolation, (2) event normalization strategies for unifying different platform formats, (3) gateway/orchestrator patterns for decoupling, and (4) resume/persistence patterns for session continuity.

**Primary recommendation:** Implement a hierarchical session map with `channel:thread` composite keys, use adapter pattern for normalization, and apply Martin Fowler's Gateway pattern for decoupling.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun | 1.x | Runtime | Project's existing stack, fast file I/O |
| crypto.randomUUID | native | Event ID generation | Standard UUID v4, no deps |
| Bun.file/Bun.write | native | Atomic file operations | Crash-safe writes |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Feature flags | custom | Gradual migration | When rolling out gateway |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Flat JSON files | SQLite | SQLite adds dep; flat files match Phase 1 pattern |
| In-memory map | Redis | Redis requires external service; project uses flat files |
| Full ORM | Manual JSON | ORM overkill for simple session mapping |

## Architecture Patterns

### Recommended Project Structure
```
src/gateway/
├── session-map.ts      # B.1 - Session Map Store
├── resume.ts           # B.2 - Resume Logic
├── normalizer.ts       # B.3 - Normalized Event Schema
├── index.ts            # B.4 - Gateway Orchestrator
└── __tests__/
    ├── session-map.test.ts
    ├── resume.test.ts
    ├── normalizer.test.ts
    └── index.test.ts
```

### Pattern 1: Composite Key Session Mapping
**What:** Hierarchical session storage using `channel:thread` composite keys
**When to use:** When multiple concurrent conversations need isolation within the same system

**Structure:**
```typescript
// session-map.json schema
{
  "telegram:123456": {
    "default": { sessionId: "abc", createdAt: "...", lastSeq: 42, turnCount: 5 },
    "thread-789": { sessionId: "def", createdAt: "...", lastSeq: 10, turnCount: 2 }
  },
  "discord:channel-xyz": {
    "default": { sessionId: "ghi", createdAt: "...", lastSeq: 100, turnCount: 20 }
  }
}
```

**Key design decisions:**
1. Use `"default"` for channels without threads (DMs, single threads)
2. Channel ID format: `"telegram:{chatId}"` or `"discord:{channelId}:{messageId}"`
3. Thread ID is platform-specific (Telegram: `message_thread_id`, Discord: `thread_id`)
4. Store `lastSeq` for event log correlation
5. Store `turnCount` for compact warning threshold tracking

**Example:**
```typescript
// Source: Phase 2 requirements + Discord Gateway patterns
interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastSeq: number;
  turnCount: number;
}

interface SessionMap {
  [channelId: string]: {
    [threadId: string]: SessionEntry;
  };
}

// API design
async function get(channel: string, thread: string = "default"): Promise<SessionEntry | null>;
async function set(channel: string, thread: string, entry: SessionEntry): Promise<void>;
async function delete(channel: string, thread: string): Promise<void>;
```

### Pattern 2: Event Normalization (Adapter Pattern)
**What:** Transform platform-specific events into a unified schema
**When to use:** When integrating multiple external systems with different data formats

**NormalizedEvent Schema:**
```typescript
interface NormalizedEvent {
  id: string;           // uuid v4
  channel: "telegram" | "discord" | "cron" | "webhook";
  channelId: string;    // platform-specific ID
  threadId?: string;    // thread/topic/guild ID
  userId: string;       // platform user ID
  text: string;
  attachments?: Attachment[];
  timestamp: number;    // Unix ms
  seq: number;          // event log sequence (assigned by gateway)
  metadata?: {          // platform-specific extras
    replyTo?: string;
    command?: string;
    entities?: any[];
  };
}

interface Attachment {
  type: "image" | "voice" | "document";
  url?: string;
  localPath?: string;
  mimeType?: string;
  filename?: string;
}
```

**Platform-specific mappings:**

| Normalized Field | Telegram Source | Discord Source |
|------------------|-----------------|----------------|
| `channelId` | `message.chat.id` | `message.channel_id` |
| `threadId` | `message.message_thread_id` | `message.thread?.id` or `"default"` |
| `userId` | `message.from.id` | `message.author.id` |
| `text` | `message.text` or `message.caption` | `message.content` |
| `attachments` | `photo`, `voice`, `document` | `attachments` |

**Example normalizer:**
```typescript
// Source: Adapter pattern from Martin Fowler
function normalizeTelegramMessage(msg: TelegramMessage): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    channel: "telegram",
    channelId: `telegram:${msg.chat.id}`,
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : "default",
    userId: String(msg.from?.id ?? "unknown"),
    text: msg.text ?? msg.caption ?? "",
    attachments: extractTelegramAttachments(msg),
    timestamp: Date.now(),
    seq: 0, // Assigned by gateway
    metadata: {
      replyTo: msg.reply_to_message?.message_id,
      entities: msg.entities,
    }
  };
}
```

### Pattern 3: Gateway Orchestrator (Martin Fowler Gateway Pattern)
**What:** Single entry point that decouples adapters from processing logic
**When to use:** When multiple clients need to use shared processing logic

**Structure:**
```typescript
// Source: Martin Fowler's Gateway pattern
class Gateway {
  private sessionMap: SessionMapStore;
  private normalizer: EventNormalizer;
  private eventLog: EventLog;
  private processor: EventProcessor;
  
  async processInboundEvent(event: NormalizedEvent): Promise<void> {
    // 1. Lookup or create session
    const session = await this.getOrCreateSession(event.channelId, event.threadId);
    
    // 2. Assign sequence number
    event.seq = await this.eventLog.getNextSeq();
    
    // 3. Append to event log
    await this.eventLog.append(event);
    
    // 4. Process with session context
    await this.processor.process(event, session);
    
    // 5. Update session lastSeq
    await this.sessionMap.updateLastSeq(event.channelId, event.threadId, event.seq);
  }
}
```

### Pattern 4: Resume with Claude CLI
**What:** Resume Claude Code sessions using `--resume <sessionId>` flag
**When to use:** When continuing conversations across multiple interactions

**Integration with runner.ts:**
```typescript
// Source: Existing runner.ts patterns
async function getResumeArgs(channel: string, thread: string): Promise<{
  sessionId: string | null;
  args: string[];
}> {
  const entry = await sessionMap.get(channel, thread);
  
  if (entry) {
    return {
      sessionId: entry.sessionId,
      args: ["--resume", entry.sessionId]
    };
  }
  
  // New session - will be created by runner
  return { sessionId: null, args: [] };
}
```

### Anti-Patterns to Avoid
- **Global singleton sessions:** Current `sessions.ts` approach causes cross-channel pollution
- **Direct adapter→runner calls:** Telegram/discord.ts call `runUserMessage()` directly - breaks isolation
- **Platform types leaking:** Don't let Telegram Message types reach the processor
- **Blocking on session creation:** Create session entries asynchronously after first response

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session ID generation | Custom counter | `crypto.randomUUID()` | UUID v4 is standard, collision-resistant |
| File locking | Custom flock | Bun.write atomic ops | Bun.write is atomic on most filesystems |
| JSON serialization | Manual string building | `JSON.stringify()` | Handles escaping, edge cases |
| Date parsing | Custom parsers | `Date.toISOString()` | ISO 8601 standard, unambiguous |
| Thread ID normalization | String concatenation | Template literals with validation | Clear, type-safe formatting |

**Key insight:** The project already uses Bun's atomic file operations in event-log.ts - follow that pattern for session-map.ts.

## Common Pitfalls

### Pitfall 1: Session ID Collisions
**What goes wrong:** Two threads create sessions simultaneously, overwrite each other's session.json
**Why it happens:** Read-modify-write race condition without proper serialization
**How to avoid:** 
- Use write queue pattern from event-log.ts
- Or use atomic file rename pattern (write to temp, rename)
**Warning signs:** Intermittent "session not found" errors, corrupted session.json

### Pitfall 2: Thread ID Format Changes
**What goes wrong:** Discord thread IDs change format, existing sessions become orphaned
**Why it happens:** Platform API changes, or different ID representations (string vs number)
**How to avoid:**
- Normalize thread IDs to strings immediately
- Version the channelId format: `"discord:v1:channelId:threadId"`
- Migration path in session-map.ts
**Warning signs:** Sessions not resuming, new sessions created for existing threads

### Pitfall 3: Memory Leak in Session Map
**What goes wrong:** Session map grows unbounded as bot joins more channels
**Why it happens:** No cleanup of old sessions
**How to avoid:**
- Implement TTL (30 days default, configurable)
- Auto-cleanup on read: if `lastSeq` older than threshold, delete entry
- Or periodic background cleanup task
**Warning signs:** session-map.json grows large, slower lookups over time

### Pitfall 4: Platform Event Format Drift
**What goes wrong:** Telegram adds new fields, normalizer breaks
**Why it happens:** Tight coupling to specific API version fields
**How to avoid:**
- Use TypeScript strict mode for compile-time checks
- Validate with Zod schema before normalization
- Graceful degradation: log unknown fields, don't crash
**Warning signs:** Type errors on deploy, runtime undefined access

### Pitfall 5: Gateway as Bottleneck
**What goes wrong:** Single gateway instance becomes performance bottleneck
**Why it happens:** All events flow through one orchestrator
**How to avoid:**
- Keep gateway logic minimal (lookup, log, route)
- Processor does heavy lifting
- Consider partitioning by channel hash for future scaling
**Warning signs:** Event processing latency increases with load

## Code Examples

### Session Map with Write Queue
```typescript
// Source: event-log.ts pattern
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const promise = writeQueue.then(() => operation());
  writeQueue = promise.catch(() => {});
  return promise;
}

async function set(channel: string, thread: string, entry: SessionEntry): Promise<void> {
  return enqueueWrite(async () => {
    const map = await loadMap();
    if (!map[channel]) map[channel] = {};
    map[channel][thread] = entry;
    await Bun.write(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
  });
}
```

### Feature Flag for Migration
```typescript
// Source: PLAN.md migration strategy
const USE_GATEWAY = process.env.USE_GATEWAY === "true" || 
                    settings.gateway?.enabled === true;

// In telegram.ts/discord.ts
if (USE_GATEWAY) {
  await gateway.processEvent(normalizedEvent);
} else {
  // Legacy path
  await runUserMessage("telegram", prompt);
}
```

### Normalized Event Type Guard
```typescript
// Source: TypeScript best practices
function isNormalizedEvent(obj: unknown): obj is NormalizedEvent {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "id" in obj &&
    "channel" in obj &&
    "channelId" in obj &&
    "userId" in obj &&
    "text" in obj &&
    "timestamp" in obj
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Global session.json | Per-channel+thread session map | Phase 2 (planned) | Isolation, resume per conversation |
| Direct runner calls | Gateway orchestrator | Phase 2 (planned) | Decoupling, easier testing |
| Platform types everywhere | Normalized events | Phase 2 (planned) | Type safety, easier new adapters |

**Deprecated/outdated:**
- Single global session: Causes conversation interleaving
- Direct adapter→runner coupling: Makes testing difficult

## Open Questions

1. **Thread ID format versioning**
   - What we know: Discord thread IDs may need versioning
   - What's unclear: When to bump version, migration strategy
   - Recommendation: Start with `"discord:{channelId}:{threadId}"`, add version prefix if needed

2. **Session cleanup granularity**
   - What we know: Need cleanup of old sessions
   - What's unclear: Per-entry TTL vs global sweep, cron vs on-demand
   - Recommendation: On-demand cleanup on read + periodic background task

3. **Gateway error handling**
   - What we know: Gateway should not crash on single event failure
   - What's unclear: Retry policy, DLQ integration
   - Recommendation: Use existing event-processor retry logic

## Validation Architecture

> Skip this section entirely if workflow.nyquist_validation is false in .planning/config.json

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Bun test runner |
| Config file | None - uses default |
| Quick run command | `bun test src/__tests__/gateway/session-map.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| B.1 | Create/get/delete sessions | unit | `bun test src/__tests__/gateway/session-map.test.ts` | ❌ Wave 0 |
| B.1 | Auto-cleanup old sessions | unit | `bun test src/__tests__/gateway/session-map.test.ts` | ❌ Wave 0 |
| B.2 | Resume args for existing session | unit | `bun test src/__tests__/gateway/resume.test.ts` | ❌ Wave 0 |
| B.2 | Create new session if not found | unit | `bun test src/__tests__/gateway/resume.test.ts` | ❌ Wave 0 |
| B.3 | Normalize Telegram event | unit | `bun test src/__tests__/gateway/normalizer.test.ts` | ❌ Wave 0 |
| B.3 | Normalize Discord event | unit | `bun test src/__tests__/gateway/normalizer.test.ts` | ❌ Wave 0 |
| B.4 | Gateway routes event to log | integration | `bun test src/__tests__/gateway/index.test.ts` | ❌ Wave 0 |
| B.4 | Feature flag disables gateway | integration | `bun test src/__tests__/gateway/index.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test src/__tests__/gateway/{module}.test.ts`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/__tests__/gateway/session-map.test.ts` — covers B.1
- [ ] `src/__tests__/gateway/resume.test.ts` — covers B.2
- [ ] `src/__tests__/gateway/normalizer.test.ts` — covers B.3
- [ ] `src/__tests__/gateway/index.test.ts` — covers B.4

## Sources

### Primary (HIGH confidence)
- Martin Fowler Gateway pattern - https://martinfowler.com/articles/gateway-pattern.html
- Discord Gateway docs - https://discord.com/developers/docs/events/gateway
- Existing codebase (event-log.ts, sessions.ts) - project patterns

### Secondary (MEDIUM confidence)
- Telegram Bot API - https://core.telegram.org/bots/api
- Adapter pattern literature

### Tertiary (LOW confidence)
- None - all claims verified with primary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Bun is established, crypto.randomUUID is native
- Architecture: HIGH - Gateway pattern is well-documented, codebase shows precedent
- Pitfalls: MEDIUM-HIGH - Based on common patterns + specific project constraints

**Research date:** 2026-03-27
**Valid until:** 2026-04-27 (30 days for stable patterns)
