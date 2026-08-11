import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function recordingProcess(chunks, outputPath) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
    final(done) {
      writeFile(outputPath, "encoded").then(() => {
        done();
        queueMicrotask(() => child.emit("close", 0, null));
      }, done);
    },
  });
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function failingWriteProcess() {
  const child = new EventEmitter();
  let endCalls = 0;
  child.stdin = new EventEmitter();
  child.stdin.write = (_chunk, done) => {
    queueMicrotask(() => {
      done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });
    return false;
  };
  child.stdin.end = () => {
    endCalls += 1;
    queueMicrotask(() => child.emit("close", 234, null));
  };
  child.stderr = new PassThrough();
  return {
    child,
    endCalls: () => endCalls,
    start() {
      queueMicrotask(() => {
        child.emit("spawn");
        child.stderr.write(
          "Padded dimensions cannot be smaller than input dimensions.\n",
        );
      });
    },
  };
}

function fileProducingProcess(outputPath) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
    final(done) {
      writeFile(outputPath, "encoded").then(() => {
        done();
        queueMicrotask(() => child.emit("close", 0, null));
      }, done);
    },
  });
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function failingFileProducingProcess(outputPath) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
    final(done) {
      writeFile(outputPath, "partial").then(() => {
        done();
        queueMicrotask(() => child.emit("close", 1, null));
      }, done);
    },
  });
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function delayedWriteProcess(outputPath) {
  const child = new EventEmitter();
  let releaseFirstWrite;
  let writeCount = 0;
  child.stdin = new EventEmitter();
  child.stdin.write = (_chunk, done) => {
    writeCount += 1;
    if (writeCount === 1) {
      releaseFirstWrite = done;
    } else {
      queueMicrotask(done);
    }
    return true;
  };
  child.stdin.end = () => {
    writeFile(outputPath, "encoded").then(
      () => child.emit("close", 0, null),
      (error) => child.emit("error", error),
    );
  };
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("spawn"));
  return {
    child,
    release() {
      releaseFirstWrite?.();
    },
  };
}

test("VideoRecorder starts ffmpeg with VP8 WebM settings", async () => {
  const module = await import("../dist/src/video-recorder.js").catch(
    () => ({}),
  );
  assert.equal(typeof module.VideoRecorder, "function");

  const calls = [];
  const recorder = new module.VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    ffmpegPath: "/custom/ffmpeg",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return fakeProcess();
    },
  });

  await recorder.start();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/custom/ffmpeg");
  assert.deepEqual(calls[0].options, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  assert.ok(calls[0].args.includes("image2pipe"));
  assert.ok(calls[0].args.includes("vp8"));
  assert.ok(calls[0].args.includes("-an"));
  assert.notEqual(calls[0].args.at(-1), "/tmp/recording.webm");
  assert.match(calls[0].args.at(-1), /\.webm$/);
});

test("VideoRecorder scales changing frame sizes into the output bounds", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  let filter;
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 1422, height: 800 },
    spawnProcess(_command, args) {
      filter = args[args.indexOf("-vf") + 1];
      return fakeProcess();
    },
  });

  await recorder.start();

  assert.match(filter, /^scale=/);
  assert.match(filter, /force_original_aspect_ratio=decrease/);
  assert.match(filter, /pad=1422:800/);
  assert.ok(filter.indexOf("scale=") < filter.indexOf("pad="));
});

test("VideoRecorder preserves elapsed time by repeating JPEG frames", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const chunks = [];
  let now = 5000;
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    now: () => now,
    spawnProcess: (_command, args) => recordingProcess(chunks, args.at(-1)),
  });
  assert.equal(typeof recorder.writeFrame, "function");
  assert.equal(typeof recorder.stop, "function");
  await recorder.start();

  recorder.writeFrame(Buffer.from("a"), 1000);
  now = 5080;
  recorder.writeFrame(Buffer.from("b"), 1080);
  await recorder.stop();

  assert.equal(chunks.length, 27);
  assert.ok(
    chunks.slice(0, 2).every((chunk) => chunk.equals(Buffer.from("a"))),
  );
  assert.ok(chunks.slice(2).every((chunk) => chunk.equals(Buffer.from("b"))));
});

test("VideoRecorder writeFrame resolves after queued bytes are accepted", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const root = await mkdtemp(join(tmpdir(), "ego-video-recorder-"));
  const outputPath = join(root, "recording.webm");
  let processState;
  const recorder = new VideoRecorder({
    outputPath,
    size: { width: 640, height: 480 },
    spawnProcess(_command, args) {
      processState = delayedWriteProcess(args.at(-1));
      return processState.child;
    },
  });
  try {
    await recorder.start();
    recorder.writeFrame(Buffer.from("a"), 0);
    const accepted = recorder.writeFrame(Buffer.from("b"), 40);
    let settled = false;
    accepted?.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(typeof accepted?.then, "function");
    assert.equal(settled, false);
    processState.release();
    await accepted;
    assert.equal(settled, true);
  } finally {
    processState?.release();
    await recorder.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("VideoRecorder accepts a zero-based frame timestamp", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const chunks = [];
  let now = 5000;
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    now: () => now,
    spawnProcess: (_command, args) => recordingProcess(chunks, args.at(-1)),
  });
  await recorder.start();

  recorder.writeFrame(Buffer.from("a"), 0);
  now = 5080;
  recorder.writeFrame(Buffer.from("b"), 80);
  await recorder.stop();

  assert.equal(chunks.length, 27);
  assert.ok(
    chunks.slice(0, 2).every((chunk) => chunk.equals(Buffer.from("a"))),
  );
  assert.ok(chunks.slice(2).every((chunk) => chunk.equals(Buffer.from("b"))));
});

test("VideoRecorder closes ffmpeg and reports stderr after a pipe failure", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const processState = failingWriteProcess();
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 1422, height: 800 },
    spawnProcess: () => {
      processState.start();
      return processState.child;
    },
  });
  await recorder.start();
  recorder.writeFrame(Buffer.from("a"), 0);
  recorder.writeFrame(Buffer.from("b"), 40);

  await assert.rejects(
    () => recorder.stop(),
    /ffmpeg.*Padded dimensions cannot be smaller/i,
  );
  assert.equal(processState.endCalls(), 1);
});

test("VideoRecorder creates the output directory before ffmpeg starts", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const root = await mkdtemp(join(tmpdir(), "ego-video-recorder-"));
  const outputPath = join(root, "nested", "recording.webm");
  try {
    const recorder = new VideoRecorder({
      outputPath,
      size: { width: 640, height: 480 },
      spawnProcess: () => fakeProcess(),
    });

    await recorder.start();

    assert.equal((await stat(dirname(outputPath))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VideoRecorder replaces the final output only after ffmpeg succeeds", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const root = await mkdtemp(join(tmpdir(), "ego-video-recorder-"));
  const outputPath = join(root, "recording.webm");
  let ffmpegOutputPath;
  try {
    await writeFile(outputPath, "existing");
    const recorder = new VideoRecorder({
      outputPath,
      size: { width: 640, height: 480 },
      spawnProcess(_command, args) {
        ffmpegOutputPath = args.at(-1);
        return fileProducingProcess(ffmpegOutputPath);
      },
    });
    await recorder.start();
    recorder.writeFrame(Buffer.from("frame"), 0);
    await recorder.stop();

    assert.notEqual(ffmpegOutputPath, outputPath);
    assert.match(ffmpegOutputPath, /\.webm$/);
    assert.equal(await readFile(outputPath, "utf8"), "encoded");
    await assert.rejects(() => stat(ffmpegOutputPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VideoRecorder preserves the final output and removes partial files after ffmpeg fails", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const root = await mkdtemp(join(tmpdir(), "ego-video-recorder-"));
  const outputPath = join(root, "recording.webm");
  let ffmpegOutputPath;
  try {
    await writeFile(outputPath, "existing");
    const recorder = new VideoRecorder({
      outputPath,
      size: { width: 640, height: 480 },
      spawnProcess(_command, args) {
        ffmpegOutputPath = args.at(-1);
        return failingFileProducingProcess(ffmpegOutputPath);
      },
    });
    await recorder.start();

    await assert.rejects(() => recorder.stop(), /ffmpeg exited with code 1/);

    assert.equal(await readFile(outputPath, "utf8"), "existing");
    await assert.rejects(() => stat(ffmpegOutputPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VideoRecorder explains how to configure a missing ffmpeg executable", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    spawnProcess() {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        const error = Object.assign(new Error("spawn ffmpeg ENOENT"), {
          code: "ENOENT",
        });
        child.emit("error", error);
      });
      return child;
    },
  });

  await assert.rejects(
    () => recorder.start(),
    /FFmpeg executable was not found.*EGO_BROWSER_FFMPEG_PATH/,
  );
});

test("VideoRecorder explains a batch shim ffmpeg path rejected by the OS", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    ffmpegPath: "C:\\tools\\ffmpeg.cmd",
    // Windows throws EINVAL synchronously out of spawn() for a .cmd/.bat
    // target, so it never reaches the process "error" event.
    spawnProcess() {
      throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    },
  });

  await assert.rejects(
    () => recorder.start(),
    /ffmpeg\.cmd.*batch shim.*EGO_BROWSER_FFMPEG_PATH at the ffmpeg executable/s,
  );
});

test("VideoRecorder reports a missing executable thrown synchronously", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    spawnProcess() {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    },
  });

  await assert.rejects(
    () => recorder.start(),
    /FFmpeg executable was not found.*EGO_BROWSER_FFMPEG_PATH/,
  );
});

test("VideoRecorder passes through an unrecognized spawn failure", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    ffmpegPath: "/usr/bin/ffmpeg",
    spawnProcess() {
      throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    },
  });

  await assert.rejects(() => recorder.start(), /spawn EACCES/);
});

test("VideoRecorder stop after a failed start does not invent an exit code", async () => {
  const { VideoRecorder } = await import("../dist/src/video-recorder.js");
  const recorder = new VideoRecorder({
    outputPath: "/tmp/recording.webm",
    size: { width: 640, height: 480 },
    ffmpegPath: "C:\\tools\\ffmpeg.cmd",
    spawnProcess() {
      throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    },
  });

  await assert.rejects(() => recorder.start(), /batch shim/);
  // The startup failure is the only error worth reporting; stopping a recorder
  // that never started must not raise "ffmpeg exited with code undefined".
  await recorder.stop();
});
