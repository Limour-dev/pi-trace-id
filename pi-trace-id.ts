import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-trace-id —— 给每次 provider 请求注入追踪/线程请求头（AxonHub 风格）。
 *
 * 语义映射（见 tracing.md）：
 *   Thread（AH-Thread-Id）  = 一整个对话会话  →  ctx.sessionManager.getSessionId()
 *   Trace （AH-Trace-Id ）  = 一条用户消息 + 它触发的所有 agent 请求
 *
 * 实现：在 before_provider_headers 层原地写 `event.headers`。
 *   一个 hook 同时覆盖 OpenAI 与 Anthropic 两种传输；retry 复用同一批头不重复触发。
 *
 * 关键：一条用户消息会被 agent 处理成多次 provider 调用，这多次调用必须共享同一个
 * Trace ID。判定完全由分支内容推导、零状态机：
 *   分支里"最近一条 role === user 的消息条目 id"在整个作答过程中恒定
 *   （agent 迭代只追加 assistant/tool 条目、不追加新 user 条目），
 *   直到用户发下一条消息才会出现新的 user 条目 → 自动旋转 Trace。
 *   该 id 存在会话文件里，/resume、compact、会话恢复都能一致复原。
 *
 * 默认不覆盖已存在的同名请求头（tracing.md：请求若自带追踪头，网关优先采用该值，
 * 与 Claude Code 的 metadata.user_id 自动提取机制兼容）。
 */

// ---- 配置区：头名可改（例如 x-claude-code-session-id / session-id） ----
const THREAD_HEADER = "AH-Thread-Id"; // 线程/会话请求头名
const TRACE_HEADER = "AH-Trace-Id"; // 追踪请求头名
// 是否覆盖上游/用户已显式设置的同名头。默认 false = 尊重已存在的值。
const OVERRIDE_EXISTING = false;
// 打印注入日志（调试用）
const VERBOSE = true;
// ---------------------------------------------------------------

interface TraceHeaders {
	thread: string | undefined;
	trace: string | undefined;
}

// 大小写不敏感地检查请求头是否已存在（避免重复同义头）。
function hasHeader(headers: Record<string, string | null | undefined>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

// 从分支推导最近一条 user 消息条目 id，作为 Trace 值（零状态、可 /resume 复原）。
// 取分支里 role===user 的最近一条 message 条目；找不到（标题生成等前置请求）返回 undefined。
function lastUserMessageId(branch: unknown[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; id?: unknown; message?: { role?: string } } | undefined;
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user" && typeof entry.id === "string") return entry.id;
	}
	return undefined;
}

// 组装要写入的头。
function buildHeaders(ctx: { sessionManager: { getSessionId(): string; getBranch(): unknown[] } }): TraceHeaders {
	return {
		thread: ctx.sessionManager.getSessionId(),
		trace: lastUserMessageId(ctx.sessionManager.getBranch()),
	};
}

function writeIfAbsent(headers: Record<string, string | null | undefined>, name: string, value: string | undefined): void {
	if (value === undefined || value === "") return;
	if (!OVERRIDE_EXISTING && hasHeader(headers, name)) return;
	headers[name] = value;
}

export default function piTraceId(pi: ExtensionAPI): void {
	pi.on("before_provider_headers", (event, ctx) => {
		const { thread, trace } = buildHeaders(ctx);

		// Thread 恒定 → 只要有会话 id 就写。
		writeIfAbsent(event.headers, THREAD_HEADER, thread);
		// Trace 需有 user 消息才写（一条 user 消息期间的多次调用共享同值）。
		writeIfAbsent(event.headers, TRACE_HEADER, trace);

		if (VERBOSE && (thread || trace)) {
			console.log("[pi-trace-id]", {
				[THREAD_HEADER]: event.headers[THREAD_HEADER] ?? null,
				[TRACE_HEADER]: event.headers[TRACE_HEADER] ?? null,
			});
		}
	});
}
