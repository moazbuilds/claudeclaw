# Roadmap: ClaudeClaw v2 Upgrade

## Vision
Transform ClaudeClaw from a fire-and-forget daemon into a robust, production-ready agent platform with durable execution, fine-grained governance, and multi-channel session management.

## Progress

| Phase | Name | Tasks | Status | Completion |
|-------|------|-------|--------|------------|
| 0 | Project Initialization | 1 | ✅ Complete | 2026-03-26 |
| 1 | Persistent Event Bus | 5 | ✅ Complete | 2026-03-26 |
| 2 | Session Gateway | Complete    | 2026-03-27 | 2026-03-27 |

## Phase 2: Session Gateway

**Goal:** Map each channel+thread combination to its own session, enabling per-conversation resume. Build the gateway layer that decouples channel adapters from event processing.

**Requirements:**
- session-isolation: per-channel+thread session mapping
- per-thread-resume: deterministic session resume by channel+thread
- event-normalization: unified event schema across platforms
- adapter-decoupling: gateway pattern for adapter independence

**Plans:**
4/5 plans complete
|------|------|-----------|------|------------|--------|
| 2-01 | [2-01-PLAN.md](phases/2-session-gateway/2-01-PLAN.md) | Session Map Store | 1 | — | ✅ Complete |
| 2-02 | [2-02-PLAN.md](phases/2-session-gateway/2-02-PLAN.md) | Normalized Event Schema | 1 | — | ✅ Complete |
| 2-03 | [2-03-PLAN.md](phases/2-session-gateway/2-03-PLAN.md) | Resume Logic | 2 | 2-01 | ✅ Complete |
| 2-04 | [2-04-PLAN.md](phases/2-session-gateway/2-04-PLAN.md) | Gateway Orchestrator | 3 | 2-01, 2-02, 2-03 | ✅ Complete |
| 3 | Policy Engine | 5 | ⏳ Planned | — |
| 4 | Cost Governance | 4 | ⏳ Planned | — |
| 5 | Orchestration | 3 | ⏳ Planned | — |
| 6 | Human Escalation | 3 | ⏳ Planned | — |
| 7 | Additional Adapters | 4 | ⏳ Planned | — |

**Total Tasks:** 29
**Completed:** 13 (45%)

## Phase Dependencies

```
Phase 0 ──────────────────────────────────────────────────►
     │
     ▼
Phase 1 (Event Bus) ──────────────────────────────────────►
     │
     ▼
Phase 2 (Gateway) ────────────────────────────────────────►
     │
     ├──► Phase 3 (Policy) ────────────────────────────────►
     │         │
     │         └──► Phase 4 (Governance) ──────────────────►
     │                    │
     │                    └──► Phase 5 (Orchestration) ────►
     │                              │
     │                              └──► Phase 6 (Escalation) ►
     │
     └──► Phase 7 (Adapters) ──────────────────────────────►
```

## Milestones

### Milestone 1: Foundation (Phases 1-2)
- Durable event log
- Session mapping
- **Target:** Core reliability improvements

### Milestone 2: Governance (Phases 3-4)
- Policy engine
- Cost tracking
- **Target:** Production-grade controls

### Milestone 3: Advanced Features (Phases 5-7)
- Task orchestration
- Human escalation
- Additional adapters
- **Target:** Enterprise readiness

## Timeline (Estimated)

| Phase | Duration | Cumulative |
|-------|----------|------------|
| 1 | 1 week | 1 week |
| 2 | 1 week | 2 weeks |
| 3 | 1 week | 3 weeks |
| 4 | 1 week | 4 weeks |
| 5 | 1 week | 5 weeks |
| 6 | 3 days | ~5.5 weeks |
| 7 | 2 days | ~6 weeks |

**Total Estimated Duration:** ~6 weeks

## Success Criteria

- [ ] All 29 tasks complete
- [ ] Test coverage > 80% for new modules
- [ ] Zero breaking changes to existing functionality
- [ ] Documentation complete for all new modules
- [ ] Performance parity or improvement vs v1

## Risk Areas

1. **Single global session** → Fixed in Phase 2
2. **No event persistence** → Fixed in Phase 1
3. **No idempotency** → Fixed in Phase 1
4. **Serial queue is process-local** → Fixed in Phase 1
5. **Policy is config-level only** → Fixed in Phase 3
6. **Model router is naive** → Fixed in Phase 4
7. **No test harness** → Fixed in U.1 (Phase 1)
