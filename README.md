# pi-trace-id

pi 扩展：给每一次 provider 请求注入线程/追踪请求头，兼容 AxonHub 的 OpenAI/Anthropic 追踪。

在 HTTP 头层（`before_provider_headers`）为每次出站请求写入：

- **Thread 头**（默认 `AH-Thread-Id`）= pi 会话 UUID（`ctx.sessionManager.getSessionId()`），贯穿整个对话会话稳定不变。
- **Trace 头**（默认 `AH-Trace-Id`）= 当前分支里**最近一条 user 消息的条目 id**。

> 语义来自 tracing.md：一条用户消息会触发多次 agent 请求，它们应归入同一个 Trace；只有新用户消息才开启新 Trace。因为 agent 迭代只追加 assistant/tool 条目、不追加新 user 条目，故"最近 user 条目 id"在一次作答期间恒定、收到下一条用户消息才旋转 —— 零状态机、零持久化。该 id 存于会话文件，`/resume`、compact、恢复会话时都能一致复原。

一个 hook 同时覆盖 OpenAI 风格与 Anthropic 风格(`/v1/messages`)两种传输；每次 provider 请求触发一次，retry 复用同一批头、不重复触发。

## 文件

- `pi-trace-id.ts` —— 单文件扩展（默认导出 factory，接收 `ExtensionAPI`）
- `package.json` —— pi package 清单（`pi.extensions` 声明扩展入口）

## 安装

本仓库是标准 pi package（`package.json` 的 `pi` manifest + `pi-package` keyword），可通过 `pi install` 从 git 安装：

```bash
pi install git:github.com/Limour-dev/pi-trace-id
```

默认写入用户级 settings（`~/.pi/agent/settings.json`）；加 `-l` 写入项目级 settings：

```bash
pi install -l git:github.com/Limour-dev/pi-trace-id
```

安装后在 pi 内 `/reload` 生效。

### 仅引用单文件（开发迭代，不经 pi install）

在 `~/.pi/settings.json` 中加一行（仅引用本仓库文件，不复制）：

```json
{ "extensions": ["/home/limour/pi-trace-id/pi-trace-id.ts"] }
```

## 配置

配置项位于 `pi-trace-id.ts` 文件顶部（配置区），为编译期常量，改后需 `/reload`：

```ts
const THREAD_HEADER = "AH-Thread-Id"; // 线程/会话请求头名（可改，如 "x-claude-code-session-id"）
const TRACE_HEADER = "AH-Trace-Id";   // 追踪请求头名（可改，如 "session-id"）
const OVERRIDE_EXISTING = false;      // true = 覆盖上游已显式设置的同名头；false = 尊重已存在值
const VERBOSE = true;                 // 注入时打印日志
```

默认不覆盖已存在的同名头：tracing.md 规定请求若自带追踪头，网关优先采用该值（与 Claude Code 的 `metadata.user_id` 自动提取机制兼容）。

## 验证

注入发生时扩展会在调试输出打印：

```
[pi-trace-id] { "AH-Thread-Id": "...", "AH-Trace-Id": "..." }
```

可在 AxonHub 管理后台 Traces 页看到同一条用户消息触发的多次请求归入同一 Trace、多条 Trace 经 Thread 关联还原完整会话。

## 明确不做（Scope Out）

- 不做 payload 改写（不写 `metadata.user_id` / Claude Code / Codex 通道），只注入 HTTP 请求头。
- 不做 uuid 生成：Trace 值直传 pi user 消息条目 id，最简、可 /resume 复原。
- 不做 Trace/Thread 值存外部存储与跨进程协调。
