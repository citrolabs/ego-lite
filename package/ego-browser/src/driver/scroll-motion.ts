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
  /** Stop before the next wheel event once this returns true. */
  exhausted?(): boolean;
};

const SINGLE_EVENT_DISTANCE = 120;
const PIXELS_PER_STEP = 80;
const MAX_STEPS = 12;
const STEP_INTERVAL_MS = 8;

/**
 * Dispatch one logical wheel action as a short eased browser-input motion.
 * Small deltas stay immediate, while page-sized deltas are spread over enough
 * input frames to remain visually continuous without creating a long gesture.
 *
 * Returns false when `exhausted()` cut the motion short. A page that handles
 * each wheel event slowly (a map that zooms on wheel, a busy main thread) can
 * make one motion take far longer than the action's deadline, so the caller's
 * budget is checked before every event rather than only between motions.
 */
export async function dispatchWheelMotion(
  services: WheelMotionServices,
  motion: WheelMotion,
): Promise<boolean> {
  const distance = Math.max(Math.abs(motion.deltaX), Math.abs(motion.deltaY));
  const steps =
    distance <= SINGLE_EVENT_DISTANCE
      ? 1
      : Math.min(MAX_STEPS, Math.ceil(distance / PIXELS_PER_STEP));
  let emittedX = 0;
  let emittedY = 0;

  for (let step = 1; step <= steps; step += 1) {
    if (step > 1 && services.exhausted?.()) return false;
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
  return true;
}
