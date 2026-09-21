import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-trace-id —— 给每次 provider 请求注入追踪/线程请求头（AxonHub 风格）。
 *
 * 语义映射：
 *   Thread（AH-Thread-Id）  = 项目路径的简单哈希（同一项目的所有会话共享同值）
 *   Trace （AH-Trace-Id ）  = 原 AH-Thread-Id 的值（会话 UUID，sessionManager.getSessionId()），
 *                            但统一重写为符合 RFC 4122 的 v4 格式
 *                            xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx。
 *                            （原会话 UUID 是 v7 版本号，这里仅做确定性格式改写，
 *                            不改变随机/确定性来源，仅保证版本与变体位合规。）
 *
 * 实现：在 before_provider_headers 层原地写 `event.headers`。
 *   一个 hook 同时覆盖 OpenAI 与 Anthropic 两种传输；retry 复用同一批头不重复触发。
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
const VERBOSE = false;
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

// 简单的字符串哈希（FNV-1a 派生），返回定长小写 hex。
// 用于把项目路径压成一个短 id 作为 AH-Thread-Id（不必防碰撞，够稳定即可）。
function simpleHash(input: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	let c = 0x85ebca6b;
	let d = 0xc2b2ae35;
	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		a ^= ch; a = Math.imul(a, 0x01000193);
		b ^= a; b = Math.imul(b, 0x85ebca6b);
		c ^= b; c = Math.imul(c, 0xc2b2ae35);
		d ^= c; d = Math.imul(d, 0x27d4eb2f);
	}
	return [a, b, c, d].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

// 把任意 UUID 字符串确定性改写为 RFC 4122 v4 格式（xxxx…-4xxx-yxxx…）：
//   版本位(第 13 个 hex)固定为 4；变体位(第 17 个 hex)归一到 8/9/a/b。
// 非 32 位 hex 的输入（会话 UUID 意外损坏时）返回 undefined。
function asV4Uuid(uuid: string | undefined): string | undefined {
	if (uuid === undefined || uuid === "") return undefined;
	const hex = uuid.replace(/-/g, "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;

	const h = hex.split("");
	h[12] = "4"; // 版本位 → v4
	const v = parseInt(h[16], 16) & 0b0011; // 保留变体低 2 位
	h[16] = (0b1000 | v).toString(16); // 变体位 → 8/9/a/b

	const groups = [
		h.slice(0, 8).join(""),
		h.slice(8, 12).join(""),
		h.slice(12, 16).join(""),
		h.slice(16, 20).join(""),
		h.slice(20, 32).join(""),
	];
	return groups.join("-");
}

// 组装要写入的头。
function buildHeaders(ctx: {
	cwd: string;
	sessionManager: { getSessionId(): string };
}): TraceHeaders {
	return {
		// Thread = 项目路径哈希（同一项目共享）。
		thread: ctx.cwd ? simpleHash(ctx.cwd) : undefined,
		// Trace = 原 AH-Thread-Id（会话 UUID），改写为 RFC 4122 v4 格式。
		trace: asV4Uuid(ctx.sessionManager.getSessionId()),
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

		// Thread 恒有 → 只要拿到项目路径就写。
		writeIfAbsent(event.headers, THREAD_HEADER, thread);
		// Trace 需有会话 UUID 才写。
		writeIfAbsent(event.headers, TRACE_HEADER, trace);

		if (VERBOSE && (thread || trace)) {
			console.log("[pi-trace-id]", {
				[THREAD_HEADER]: event.headers[THREAD_HEADER] ?? null,
				[TRACE_HEADER]: event.headers[TRACE_HEADER] ?? null,
			});
		}
	});
}
