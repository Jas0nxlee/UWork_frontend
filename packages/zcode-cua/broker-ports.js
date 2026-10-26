export function isCuaPermissionStatusAvailable(result) {
  const states = ["granted", "stale", "denied", "unknown"];
  // Host 的成功快照历史上省略 available；占位实现只检查 true，误把真实权限也投影成未知。
  return (
    Boolean(result) &&
    typeof result === "object" &&
    result.available !== false &&
    states.includes(result.accessibility) &&
    states.includes(result.screenRecording)
  );
}

export function shouldRunCuaScreenCaptureProbe(state, options) {
  return (
    state === "granted" &&
    (options?.includeFunctionalProbes === true || options?.probeScreenCapture === true)
  );
}
