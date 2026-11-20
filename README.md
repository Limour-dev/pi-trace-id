# pi-trace-id

pi 扩展：给每一次 provider 请求注入线程/追踪请求头，兼容 AxonHub 的 OpenAI/Anthropic 追踪。

在 HTTP 头层（`before_provider_headers`）为每次出站请求写入：

- **Thread 头**（默认 `AH-Thread-Id`）= 项目路径的**简单哈希**（`ctx.cwd` 经 FNV-1a 派生哈希），同一项目下的所有会话共享同值。
- **Trace 头**（默认 `AH-Trace-Id`）= 原 Thread 值，即会话 UUID（`ctx.sessionManager.getSessionId()`），但统一改写为符合 RFC 4122 的 v4 格式 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`（版本位固定 `4`、变体位归一到 `8/9/a/b`）。
- **Turn 头**（默认 `AH-Turn-Id`）= 最近一条 **user 消息**的 session 条目 id（`ctx.sessionManager.getBranch()` 末尾向前找到的第一条 `message` + `role: "user"` 的 `id`，通常是 8 位 hex），同样改写为 RFC 4122 v4 UUID：完整 UUID 直接改写版本/变体位，不足 32 位 hex 的条目 id 先用同一确定性哈希扩到 32 位 hex 再改写。同一条用户消息触发的所有请求共用同一个 Turn 值，用户发出下一条消息后 Turn 值随之变化。
> 原会话 UUID 是 v7（版本位 `7`），本扩展仅在写入请求头前做确定性格式改写：不改变随机来源，只把版本/变体位合规化，从而满足 RFC 4122 v4 的格式约束。

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

### 安装体积

本扩展运行时零依赖（唯一的 import 是 `import type`，转译时被完全擦除），git 安装额外占用 ~0，不会拉取宿主包。

两点保障：

1. `peerDependenciesMeta` 把 `@earendil-works/pi-coding-agent` 标为 `optional`，npm/bun/pnpm 都不会再自动装它。
   pi 的 git 安装路径只传 `--omit=dev`（见 `dist/core/package-manager.js` 的
   `getGitDependencyInstallArgs`），所以不带这个标记时 git 安装会额外拖进一份 ~440 MB 的宿主副本。
2. 仓库根的 `.npmrc` 设了 `legacy-peer-deps` + `omit=optional`，作为 git 安装路径的兜底，并跳过 esbuild 那 26 个
   预编译平台二进制（单个可用，其余约 284 MB 是死重量）。

### 开发

```bash
npm install        # 仅开发用类型，~178 MB，不影响安装方
npm run typecheck
```

宿主类型只用于 `npm run typecheck` 和 IDE 补全，属于 `devDependencies`，消费者不会安装。

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
const TURN_HEADER = "AH-Turn-Id";     // 单条用户消息（转向）请求头名
const OVERRIDE_EXISTING = false;      // true = 覆盖上游已显式设置的同名头；false = 尊重已存在值
const VERBOSE = true;                 // 注入时打印日志
```

默认不覆盖已存在的同名头：tracing.md 规定请求若自带追踪头，网关优先采用该值（与 Claude Code 的 `metadata.user_id` 自动提取机制兼容）。

## 验证

注入发生时扩展会在调试输出打印：

```
[pi-trace-id] { "AH-Thread-Id": "...", "AH-Trace-Id": "...", "AH-Turn-Id": "..." }
```

每个对话会话（一条 Trace，即原会话 UUID 的 v4 改写）都会带上前缀项目哈希（AH-Thread-Id），可在 AxonHub 管理后台按项目 Thread 归组查看多个会话的 Trace。

`AH-Turn-Id` 再把会话内的一次用户输入单独标识出来：同一条 user 消息触发的多次 agent 请求共用一个 Turn 值，便于在 Trace 内按"第几轮用户输入"切分。

## 明确不做（Scope Out）

- 不做 payload 改写（不写 `metadata.user_id` / Claude Code / Codex 通道），只注入 HTTP 请求头。
- 不做新的随机 uuid 生成：Trace 直接沿用会话 UUID，Turn 直接沿用最近一条 user 消息的条目 id，二者都只做确定性 v4 格式改写；Thread 由项目路径确定性哈希而来。三者均可跨会话稳定复现。
- 不做 Trace/Thread/Turn 值存外部存储与跨进程协调。
