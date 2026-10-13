const MIN_PORT = 1024;
const MAX_PORT = 65535;

function assertPort(port) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new TypeError(`端口必须是 ${MIN_PORT}–${MAX_PORT} 之间的整数`);
  }
}

// 只认本机 app.asar 内的渲染页，排除外部网页与 devtools 页
export function isRendererTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  if (target.type !== "page" && target.type !== "webview") return false;

  const url = typeof target.url === "string" ? target.url : "";
  if (/^https?:\/\//i.test(url)) return false;
  if (url.startsWith("devtools://") || url.includes("chrome-devtools")) return false;
  if (!(url.startsWith("file://") || url.includes("app.asar"))) return false;

  try {
    const parsed = new URL(target.webSocketDebuggerUrl);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || !parsed.port) return false;
    assertPort(Number(parsed.port));
  } catch {
    return false;
  }
  return true;
}

export async function fetchTargets(port, { timeoutMs = 4000 } = {}) {
  assertPort(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CDP 目标发现失败：HTTP ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error("CDP 目标响应不是数组");
    return list.filter(isRendererTarget);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForTargets(port, { timeoutMs = 25000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const budget = Math.max(500, Math.min(2500, deadline - Date.now()));
      const targets = await fetchTargets(port, { timeoutMs: budget });
      if (targets.length > 0) return targets;
      lastError = new Error("未发现 app.asar 渲染页");
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 CDP 渲染页超时（${timeoutMs}ms）：${lastError?.message ?? "未知错误"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export class CdpSession {
  constructor(webSocketDebuggerUrl, { commandTimeoutMs = 8000, connectTimeoutMs = 8000, onEvent } = {}) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.closed = false;
    this.opening = null;
  }

  open() {
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.webSocketDebuggerUrl);
      } catch (error) {
        reject(new Error(`无法创建 CDP WebSocket：${error.message}`));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        reject(new Error("CDP WebSocket 连接超时"));
        this.close();
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        clearTimeout(timer);
        this.send("Runtime.enable").then(() => resolve(this), (error) => {
          reject(error);
          this.close();
        });
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 发生错误"));
      };
      socket.onclose = () => {
        this.closed = true;
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("CDP 连接已关闭"));
        }
        this.pending.clear();
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        // 不带 id 的是事件（如 Runtime.bindingCalled），交给 onEvent
        if (!Number.isInteger(message?.id)) {
          if (this.onEvent && message?.method) {
            try {
              this.onEvent(message);
            } catch {
              // 事件处理异常不应影响会话
            }
          }
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`CDP ${entry.method} 失败：${message.error.message}`));
        else entry.resolve(message.result);
      };
    });
    return this.opening;
  }

  send(method, params = {}, { timeoutMs } = {}) {
    if (this.closed || !this.socket) return Promise.reject(new Error("CDP 会话尚未就绪"));
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : this.commandTimeoutMs;
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${budget}ms）`));
      }, budget);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 发送失败：${error.message}`));
      }
    });
  }

  async evaluate(expression, options) {
    if (typeof expression !== "string") throw new TypeError("evaluate 需要字符串表达式");
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      options,
    );
    if (result?.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "未知异常";
      throw new Error(`页面执行异常：${detail}`);
    }
    return result?.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // 关闭失败无需处理
    }
  }
}
