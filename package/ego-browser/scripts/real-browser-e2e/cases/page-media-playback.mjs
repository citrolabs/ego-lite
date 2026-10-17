export function pageMediaPlaybackCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/media-workbench");
    await page.waitForSelector('body[data-media-ready="true"]', {
      timeout: 10_000,
    });

    const initial = await page.evaluate(() => window.__mediaWorkbench.read());
    assertEqual(initial.ready, true, "the generated media fixture becomes ready");
    assert(initial.video.readyState >= 1, "video metadata is available");
    assert(
      initial.audio.duration >= 2.9 && initial.audio.duration <= 3.1,
      "audio exposes its generated three-second duration"
    );

    await page.click("#video-play");
    await page.waitForSelector('#test-video[data-progressed="true"]', {
      timeout: 5_000,
    });
    await page.click("#video-pause");
    const playedVideo = await page.evaluate(() => window.__mediaWorkbench.read().video);
    assertEqual(playedVideo.paused, true, "video pauses after visibly progressing");
    assert(playedVideo.currentTime >= 0.15, "video playback advances currentTime");
    assert(
      playedVideo.events.play >= 1 &&
        playedVideo.events.playing >= 1 &&
        playedVideo.events.pause >= 1,
      "video emits play, playing, and pause events"
    );

    await page.click("#video-rate");
    await page.click("#video-mute");
    const mutedVideo = await page.evaluate(() => window.__mediaWorkbench.read().video);
    assertEqual(mutedVideo.playbackRate, 1.5, "video playback rate changes through the UI");
    assertEqual(mutedVideo.muted, true, "video can be muted through the UI");
    await page.click("#video-mute");
    assertEqual(
      (await page.evaluate(() => window.__mediaWorkbench.read().video)).muted,
      false,
      "video can be unmuted through the UI"
    );

    const other = await newPageAt(task, baseUrl + "/?workflow=media-page-switch");
    await other.snapshot();

    await page.click("#audio-play");
    await page.waitForSelector('#test-audio[data-progressed="true"]', {
      state: "attached",
      timeout: 5_000,
    });
    await page.click("#audio-pause");
    const playedAudio = await page.evaluate(() => window.__mediaWorkbench.read().audio);
    assertEqual(playedAudio.paused, true, "audio pauses after the media Page is reactivated");
    assert(playedAudio.currentTime >= 0.15, "audio playback advances currentTime");

    await page.click("#audio-seek");
    await page.click("#audio-volume");
    const final = await page.evaluate(() => window.__mediaWorkbench.read());
    assert(
      final.audio.currentTime >= 1.15 && final.audio.currentTime <= 1.3,
      "audio seeks to the requested position"
    );
    assertEqual(final.audio.volume, 0.25, "audio volume changes through the UI");
    assert(
      final.audio.events.seeking >= 1 && final.audio.events.seeked >= 1,
      "audio emits seeking and seeked events"
    );
    assertEqual(final.trustedControls, true, "all media controls receive trusted clicks");
    assertEqual(final.errors.length, 0, "media setup and controls report no errors");

    const screenshotPath = join(artifactDir, "media-workbench.png");
    await page.screenshot({ path: screenshotPath });
    assert((await stat(screenshotPath)).size > 500, "media playback produces a visual artifact");

    await other.close();
    await page.close();
  `;
}
