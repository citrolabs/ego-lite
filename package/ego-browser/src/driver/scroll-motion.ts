type WheelMotion = {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers?: number;
};

type WheelMotionServices = {
  dispatch(params: Record<string, unknown>): Promise<void>;
  sleep(ms: number): Promise<void>;
};

const SINGLE_EVENT_DISTANCE = 120;
const PIXELS_PER_STEP = 80;
const MAX_STEPS = 12;
const STEP_INTERVAL_MS = 8;

/**
 * Dispatch one logical wheel action as a short eased browser-input motion.
 * Small deltas stay immediate, while page-sized deltas are spread over enough
 * input frames to remain visually continuous without creating a long gesture.
 */
export async function dispatchWheelMotion(
  services: WheelMotionServices,
  motion: WheelMotion,
): Promise<void> {
  const distance = Math.max(Math.abs(motion.deltaX), Math.abs(motion.deltaY));
  const steps =
    distance <= SINGLE_EVENT_DISTANCE
      ? 1
      : Math.min(MAX_STEPS, Math.ceil(distance / PIXELS_PER_STEP));
  let emittedX = 0;
  let emittedY = 0;

  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const eased = progress * progress * (3 - 2 * progress);
    const cumulativeX = step === steps ? motion.deltaX : motion.deltaX * eased;
    const cumulativeY = step === steps ? motion.deltaY : motion.deltaY * eased;
    const deltaX = cumulativeX - emittedX;
    const deltaY = cumulativeY - emittedY;
    emittedX = cumulativeX;
    emittedY = cumulativeY;

    await services.dispatch({
      type: "mouseWheel",
      x: motion.x,
      y: motion.y,
      modifiers: motion.modifiers ?? 0,
      deltaX,
      deltaY,
    });
    if (step < steps) await services.sleep(STEP_INTERVAL_MS);
  }
}
