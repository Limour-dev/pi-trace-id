import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-trace-id —— 给每次 provider 请求注入追踪/线程请求头（AxonHub 风格）。
 *
 * 语义映射：
 *   Thread（AH-Thread-Id）  = 项目路径的确定性 v4 UUID 派生值（sha256(cwd) 取前 16 字节并合规化），
 *                            同一项目的所有会话共享同值。
 *   Trace （AH-Trace-Id ）  = 原 AH-Thread-Id 的值（会话 UUID，sessionManager.getSessionId()），
 *                            但统一重写为符合 RFC 4122 的 v4 格式
 *                            xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx。
 *                            （原会话 UUID 是 v7 版本号，这里仅做确定性格式改写，
 *                            不改变随机/确定性来源，仅保证版本与变体位合规。）
 *   Turn  （AH-Turn-Id  ）  = 最近一条 user 消息的条目 id（session 条目 id，通常 8 位 hex），
 *                            同样改写为符合 RFC 4122 的 v4 格式。
 *                            同一条用户消息触发的所有请求共用同一个 Turn-Id，
 *                            用户发出新消息后 Turn-Id 随之变化。
 * 实现：在 before_provider_headers 层原地写 `event.headers`。
 *   一个 hook 同时覆盖 OpenAI 与 Anthropic 两种传输；retry 复用同一批头不重复触发。
 *
 * 默认不覆盖已存在的同名请求头（tracing.md：请求若自带追踪头，网关优先采用该值，
 * 与 Claude Code 的 metadata.user_id 自动提取机制兼容）。
 */

// ---- 配置区：头名可改（例如 x-claude-code-session-id / session-id） ----
const THREAD_HEADER = "AH-Thread-Id"; // 线程/会话请求头名
const TRACE_HEADER = "AH-Trace-Id"; // 追踪请求头名
const TURN_HEADER = "AH-Turn-Id"; // 单条用户消息（转向）请求头名
// 是否覆盖上游/用户已显式设置的同名头。默认 false = 尊重已存在的值。
const OVERRIDE_EXISTING = false;
// 打印注入日志（调试用）
const VERBOSE = false;
// ---------------------------------------------------------------

interface TraceHeaders {
	thread: string | undefined;
	trace: string | undefined;
	turn: string | undefined;
}

// 大小写不敏感地检查请求头是否已存在（避免重复同义头）。
function hasHeader(headers: Record<string, string | null | undefined>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

// 把任意字符串确定性地派生为 RFC 4122 v4 UUID：
//   sha256(input) 取前 32 位 hex，再合规化版本位/变体位（见 asV4Uuid）。
// 同一输入恒定同值：不需要随机数，也不需要落盘缓存。
function uuidV4FromString(input: string): string {
	const hex = createHash("sha256").update(input).digest("hex").slice(0, 32);
	return asV4Uuid(hex) as string;
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
// 从 session 条目列表末尾往前找最近一条 user 消息，返回其条目 id。
// 同一次用户输入触发的所有请求都会命中同一条目 → 同一个 Turn-Id。
function latestUserEntryId(entries: readonly unknown[] | undefined): string | undefined {
	for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
		const e = entries![i] as { type?: string; id?: string; message?: { role?: string } } | undefined;
		if (e && e.type === "message" && e.message?.role === "user" && typeof e.id === "string" && e.id !== "") {
			return e.id;
		}
	}
	return undefined;
}

// 把 session 条目 id 改写成 RFC 4122 v4 格式的 UUID：
//   条目 id 通常是 8 位 hex（也可能是完整 UUID），32 位 hex 直接改写；
//   其余情况用 sha256 确定性派生 32 位 hex 再改写（同一 id 恒定同值）。
function asV4FromEntryId(entryId: string | undefined): string | undefined {
	if (entryId === undefined || entryId === "") return undefined;
	return asV4Uuid(entryId) ?? uuidV4FromString(entryId);
}
// 组装要写入的头。
function buildHeaders(ctx: {
	cwd: string;
	sessionManager: {
		getSessionId(): string;
		getBranch?(): readonly unknown[];
		getEntries?(): readonly unknown[];
	};
}): TraceHeaders {
	const sm = ctx.sessionManager;
	const entries = sm.getBranch?.() ?? sm.getEntries?.();
	return {
		// Thread = 项目路径派生的 v4 UUID（同一项目共享、跨会话稳定）。
		thread: ctx.cwd ? uuidV4FromString(ctx.cwd) : undefined,
		// Trace = 原 AH-Thread-Id（会话 UUID），改写为 RFC 4122 v4 格式。
		trace: asV4Uuid(ctx.sessionManager.getSessionId()),
		// Turn = 最近一条 user 消息的条目 id，同样改写为 RFC 4122 v4 格式。
		turn: asV4FromEntryId(latestUserEntryId(entries)),
	};
}

function writeIfAbsent(headers: Record<string, string | null | undefined>, name: string, value: string | undefined): void {
	if (value === undefined || value === "") return;
	if (!OVERRIDE_EXISTING && hasHeader(headers, name)) return;
	headers[name] = value;
}

export default function piTraceId(pi: ExtensionAPI): void {
	pi.on("before_provider_headers", (event, ctx) => {
		const { thread, trace, turn } = buildHeaders(ctx);

		// Thread 恒有 → 只要拿到项目路径就写。
		writeIfAbsent(event.headers, THREAD_HEADER, thread);
		// Trace 需有会话 UUID 才写。
		writeIfAbsent(event.headers, TRACE_HEADER, trace);
		// Turn 需能定位到最近一条 user 消息才写。
		writeIfAbsent(event.headers, TURN_HEADER, turn);

		if (VERBOSE && (thread || trace || turn)) {
			console.log("[pi-trace-id]", {
				[THREAD_HEADER]: event.headers[THREAD_HEADER] ?? null,
				[TRACE_HEADER]: event.headers[TRACE_HEADER] ?? null,
				[TURN_HEADER]: event.headers[TURN_HEADER] ?? null,
			});
		}
	});
}
