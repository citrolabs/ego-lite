import { resolve } from "node:path";

import {
  browserCdp,
  ensureSession,
  subscribeBrowserEvent,
} from "../browser-runtime.js";
import { VideoRecorder } from "../video-recorder.js";
import { pageInfo } from "./nav.js";

type Size = { width: number; height: number };
type ScreencastOptions = {
  path: string;
  size?: Size;
  quality?: number;
};

const defaults = {
  browserCdp,
  ensureSession,
  pageInfo,
  subscribeBrowserEvent,
  createRecorder: (options) => new VideoRecorder(options),
  now: Date.now,
};
let dependencies = { ...defaults };
let activeRecording: any;

/**
 * Start recording the current page viewport to a silent VP8 WebM file.
 * The recording is bound to the current CDP session and must be stopped in the same script.
 * @param {{path:string,size?:{width:number,height:number},quality?:number}} options Output path, optional frame bounds, and JPEG quality from 0 to 100.
 * @returns {Promise<{dispose:()=>Promise<void>,[Symbol.asyncDispose]:()=>Promise<void>}>} Disposable that stops and finalizes the recording.
 */
export async function startScreencast(options: ScreencastOptions) {
  if (
    !options ||
    typeof options.path !== "string" ||
    !options.path.endsWith(".webm")
  ) {
    throw new Error("page.screencast.start path must end with .webm");
  }
  const quality = options.quality ?? 90;
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw new Error("page.screencast.start quality must be between 0 and 100");
  }
  if (
    options.size &&
    (!Number.isInteger(options.size.width) ||
      !Number.isInteger(options.size.height) ||
      options.size.width < 2 ||
      options.size.height < 2)
  ) {
    throw new Error(
      "page.screencast.start width and height must be at least 2 pixels",
    );
  }
  if (activeRecording) throw new Error("Screencast is already started");
  const sessionId = await dependencies.ensureSession();
  const size = evenSize(options.size ?? (await defaultSize()));
  const recorder = dependencies.createRecorder({
    outputPath: resolve(options.path),
    size,
  });
  await recorder.start();
  const recording: any = {
    sessionId,
    recorder,
    unsubscribe: () => {},
    receivedFrames: false,
    quality,
    frameChain: Promise.resolve(),
  };
  activeRecording = recording;
  try {
    recording.unsubscribe = dependencies.subscribeBrowserEvent(
      "Page.screencastFrame",
      sessionId,
      (event) => {
        recording.receivedFrames = true;
        recording.frameChain = recording.frameChain
          .then(async () => {
            const cdpTimestamp = event.params?.metadata?.timestamp;
            const timestamp =
              typeof cdpTimestamp === "number"
                ? cdpTimestamp * 1000
                : dependencies.now();
            await recorder.writeFrame(
              Buffer.from(event.params.data, "base64"),
              timestamp,
            );
            await dependencies.browserCdp(
              "Page.screencastFrameAck",
              { sessionId: event.params.sessionId },
              sessionId,
            );
          })
          .catch((error) => {
            recording.error ??= error;
          });
      },
    );
    await dependencies.browserCdp(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality,
        maxWidth: size.width,
        maxHeight: size.height,
      },
      sessionId,
    );
  } catch (error) {
    activeRecording = undefined;
    recording.unsubscribe();
    await recorder.stop().catch(() => {});
    throw error;
  }
  const dispose = async () => {
    if (activeRecording === recording) await stopScreencast();
  };
  return { dispose, [Symbol.asyncDispose]: dispose };
}

/**
 * Stop and finalize the active page screencast. Resolves after FFmpeg closes the WebM file.
 * @returns {Promise<void>}
 */
export async function stopScreencast() {
  const recording = activeRecording;
  if (!recording) return;
  activeRecording = undefined;
  let stopError = recording.error;
  recording.unsubscribe();
  await recording.frameChain;
  stopError ??= recording.error;
  try {
    if (!recording.receivedFrames) {
      const response = await dependencies.browserCdp(
        "Page.captureScreenshot",
        { format: "jpeg", quality: recording.quality },
        recording.sessionId,
      );
      const data = response.result?.data ?? response.data;
      await recording.recorder.writeFrame(
        Buffer.from(data, "base64"),
        dependencies.now(),
      );
    }
  } catch (error) {
    stopError ??= error;
  }
  try {
    await dependencies.browserCdp(
      "Page.stopScreencast",
      {},
      recording.sessionId,
    );
  } catch (error) {
    stopError ??= error;
  }
  try {
    await recording.recorder.stop();
  } catch (error) {
    stopError ??= error;
  }
  if (stopError) throw stopError;
}

// An explicit size is rejected below 2 pixels, but the derived one used to go
// through unchecked: page.info() reports { dialog } (no w/h) while a JavaScript
// dialog is open and w/h of 0 for a tab that is not really there, and both
// collapse to 0x0 here, which reaches ffmpeg as scale=0:0 and fails with an
// encoder error that says nothing about the real cause.
async function defaultSize() {
  const info = await dependencies.pageInfo();
  if (info && "dialog" in info) {
    throw new Error(
      "page.screencast.start cannot measure the page while a JavaScript dialog is open. Handle the dialog first, or pass an explicit size.",
    );
  }
  const scale = Math.min(1, 800 / Math.max(info.w, info.h));
  const size = evenSize({
    width: Math.floor(info.w * scale),
    height: Math.floor(info.h * scale),
  });
  if (!(size.width >= 2) || !(size.height >= 2)) {
    throw new Error(
      `page.screencast.start could not derive a recordable size from the current viewport (w: ${info.w}, h: ${info.h}). Restore the real tab, or pass an explicit size.`,
    );
  }
  return size;
}

function evenSize(size: Size) {
  return { width: size.width & ~1, height: size.height & ~1 };
}

export const __testing = {
  setOverrides(overrides) {
    const previous = dependencies;
    dependencies = { ...dependencies, ...overrides };
    return () => {
      dependencies = previous;
    };
  },
};
