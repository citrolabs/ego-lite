import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWheelMotion } from "../../dist/src/driver/scroll-motion.js";

test("dispatchWheelMotion preserves the requested delta within one bounded motion", async () => {
  const events = [];
  const sleeps = [];

  await dispatchWheelMotion(
    {
      async dispatch(event) {
        events.push(event);
      },
      async sleep(ms) {
        sleeps.push(ms);
      },
    },
    { x: 40, y: 80, deltaX: -150, deltaY: 600, modifiers: 2 },
  );

  assert(events.length > 1);
  assert(events.length <= 12);
  assert.equal(
    events.reduce((total, event) => total + event.deltaX, 0),
    -150,
  );
  assert.equal(
    events.reduce((total, event) => total + event.deltaY, 0),
    600,
  );
  assert(events.every((event) => event.x === 40 && event.y === 80));
  assert(events.every((event) => event.modifiers === 2));
  assert(sleeps.reduce((total, duration) => total + duration, 0) <= 88);
});

test("dispatchWheelMotion paces a page-sized scroll without visible jumps", async () => {
  const events = [];
  const sleeps = [];

  await dispatchWheelMotion(
    {
      async dispatch(event) {
        events.push(event);
      },
      async sleep(ms) {
        sleeps.push(ms);
      },
    },
    { x: 400, y: 300, deltaX: 0, deltaY: 960 },
  );

  assert(events.length >= 10);
  assert(events.length <= 12);
  assert(
    events.every((event) => event.deltaY > 0 && event.deltaY <= 960 * 0.18),
    "a single wheel event must not carry a visibly large part of the motion",
  );
  const duration = sleeps.reduce((total, value) => total + value, 0);
  assert(duration >= 80);
  assert(duration <= 100);
});

test("dispatchWheelMotion keeps small wheel actions immediate", async () => {
  const events = [];
  const sleeps = [];

  await dispatchWheelMotion(
    {
      async dispatch(event) {
        events.push(event);
      },
      async sleep(ms) {
        sleeps.push(ms);
      },
    },
    { x: 0, y: 0, deltaX: 0, deltaY: 100 },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].deltaY, 100);
  assert.deepEqual(sleeps, []);
});
