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
| Reliability | Simple reliable system for agents | Bugs nightmare |
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

### Core Automation

#### Heartbeat
Periodic check-ins on a configurable interval with quiet hours support. Fully manageable: you can change both the heartbeat schedule and the heartbeat prompt whenever needed.

#### Cron Jobs
Run any job on a schedule with timezone awareness, either in repeated patterns or one-time runs. The runtime handles execution flow and keeps the system reliable.

### Communication

#### Channels
- Telegram: text, image, and voice support.
- Discord: coming soon.

#### Time Awareness
Every message can include a time prefix so the agent stays aware of timing, understands delays, and aligns better with your daily patterns and expected tasks.

### Reliability

#### GLM Fallback
If your main subscription/model limit is hit, you can configure fallback to GLM models so your agent keeps running without stopping.

### Control and Visibility

#### Web Dashboard
Monitor runs, edit jobs, and inspect logs in real time from a manageable UI.

#### Security Levels
Use four access levels from read-only to full system access, depending on how much control you want to grant.

#### Model Selection
Pick the model setup that fits your workload and switch when needed.

## FAQ

### 1. Does ClaudeClaw can do `<something>`?
Anything that can be done by Claude Code can be done by ClaudeClaw. ClaudeClaw adds cron jobs, heartbeats, and works as a bridge to Telegram.
Give your ClaudeClaw any skills or teach it anything.

### Is this project breaking Anthropic ToS?
No. Technically, this project is not a third-party OAuth integration. It is local usage inside the Claude Code ecosystem and directly wraps Claude Code. If you build your own scripts to do the same, it would not be considered ToS-breaking.

### 2. Does Anthropic will sue you?
I hope no.

## Screenshots

### Claude Code Folder-Based Status Bar
![Claude Code folder-based status bar](images/bar.png)

### Cool UI to Manage and Check Your ClaudeClaw
![Cool UI to manage and check your ClaudeClaw](images/dashboard.png)
