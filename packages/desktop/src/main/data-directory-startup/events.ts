import type { EventEmitter } from "node:events";
/** 只在业务 Main 尚未注册时暂存平台事件，不做任务/工作区路由。 */
export function bufferMainLifecycleIntents(
  emitter: Pick<EventEmitter, "on" | "removeListener" | "emit">,
) {
  const events: Array<{ name: "open-url" | "second-instance"; args: unknown[] }> = [];
  let active = true;
  const open = (...args: unknown[]) => {
    (args[0] as { preventDefault?: () => void } | undefined)?.preventDefault?.();
    events.push({ name: "open-url", args });
  };
  const second = (...args: unknown[]) => events.push({ name: "second-instance", args });
  emitter.on("open-url", open);
  emitter.on("second-instance", second);
  const remove = () => {
    emitter.removeListener("open-url", open);
    emitter.removeListener("second-instance", second);
  };
  return {
    handoff() {
      if (!active) return;
      active = false;
      remove();
      for (const event of events.splice(0)) emitter.emit(event.name, ...event.args);
    },
    dispose() {
      if (!active) return;
      active = false;
      remove();
      events.length = 0;
    },
  };
}
