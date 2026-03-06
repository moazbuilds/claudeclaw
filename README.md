<p align="center">
  <img src="images/claudeclaw-banner.svg" alt="ClaudeClaw Banner" />
</p>
<p align="center">
  <img src="images/claudeclaw-wordmark.png" alt="ClaudeClaw Wordmark" />
</p>

<p align="center"><b>A lightweight, open-source OpenClaw version built into your Claude Code.</b></p>

ClaudeClaw turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executing tasks on a schedule, responding to messages on Telegram, transcribing voice commands, and integrating with any service you need.

## Why ClaudeClaw?

| Category | ClaudeClaw | OpenClaw |
| --- | --- | --- |
| Anthropic Will Sue You | No | Yes |
| API Overhead | Directly uses your Claude Code subscription | Nightmare |
| Setup & Installation | ~5 minutes | Nightmare |
| Deployment | Install Claude Code on any device or VPS and run | Nightmare |
| Isolation Model | Folder-based and isolated as needed | Global by default (security nightmare) |
| Reliability | Simple cron and heartbeats system | Bugs nightmare |
| Feature Scope | Lightweight features you actually use | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Nightmare |
| Cost Efficiency | Efficient usage | Nightmare |
| Memory | Uses Claude internal memory system + `CLAUDE.md` | Nightmare |

## Getting Started in 5 Minutes

```bash
claude plugin marketplace add moazbuilds/claudeclaw
claude plugin install claudeclaw
```
Then open a Claude Code session and run:
```
/claudeclaw:start
```
The setup wizard walks you through model, heartbeat, Telegram, and security, then your daemon is live with a web dashboard.

## Features

- **Heartbeat** periodic check-ins on a configurable interval with quiet hours support
- **Cron Jobs** schedule any prompt with standard cron syntax, timezone-aware
- **Telegram Bot** chat with your agent from anywhere with text, images, and voice
- **Web Dashboard** monitor runs, edit jobs, view logs in real time
- **Security Levels** four granular levels from read-only to full system access
- **Model Selection** choose between Opus, Sonnet, or Haiku per project

![ClaudeClaw Status Bar](images/bar.png)

![ClaudeClaw Dashboard](images/dashboard.png)
