export const GPU_MODES = Object.freeze([
  "normal",
  "balanced",
  "low-power",
  "software",
]);

export const GRAPHITE_DISABLED_EXPERIMENT = "skia-graphite@5";

export function assertGpuMode(mode) {
  if (!GPU_MODES.includes(mode)) {
    throw new Error(`unsupported GPU mode: ${JSON.stringify(mode)}`);
  }
  return mode;
}

export function applyModeToLocalState(value, mode) {
  assertGpuMode(mode);
  const state = cloneJsonObject(value);
  const browser = isObject(state.browser) ? state.browser : {};
  const experiments = Array.isArray(browser.enabled_labs_experiments)
    ? browser.enabled_labs_experiments.filter(
        (item) => typeof item === "string" && !item.startsWith("skia-graphite"),
      )
    : [];

  if (mode === "balanced") {
    experiments.push(GRAPHITE_DISABLED_EXPERIMENT);
  }

  const hardwareAccelerationMode = isObject(state.hardware_acceleration_mode)
    ? state.hardware_acceleration_mode
    : {};
  hardwareAccelerationMode.enabled = mode !== "software";

  browser.enabled_labs_experiments = experiments;
  state.browser = browser;
  state.hardware_acceleration_mode = hardwareAccelerationMode;
  delete state.hardware_acceleration_mode_enabled;
  delete state["hardware_acceleration_mode.enabled"];
  return state;
}

export function detectMode(localState, savedMode) {
  if (savedMode === "low-power") {
    return savedMode;
  }
  if (localState?.hardware_acceleration_mode?.enabled === false) {
    return "software";
  }
  if (
    localState?.browser?.enabled_labs_experiments?.includes(
      GRAPHITE_DISABLED_EXPERIMENT,
    )
  ) {
    return "balanced";
  }
  return "normal";
}

export function launchArguments(mode) {
  assertGpuMode(mode);
  return mode === "low-power" ? ["--disable-webgl"] : [];
}

function cloneJsonObject(value) {
  if (!isObject(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
