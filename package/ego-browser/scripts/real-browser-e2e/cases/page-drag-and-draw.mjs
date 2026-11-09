export function pageDragAndDrawCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/pointer-workbench");
    const beforePath = join(artifactDir, "pointer-workbench-before.png");
    const afterPath = join(artifactDir, "pointer-workbench-after.png");
    await page.screenshot({ path: beforePath });

    await page.dragAndDrop("#drag-source", "#drop-target");
    const dragged = await page.evaluate(() => window.__pointerWorkbench.read().drag);
    assertEqual(dragged.landed, true, "dragAndDrop moves the element into the target");
    assert(dragged.moveCount >= 1, "dragAndDrop delivers movement while the button is held");
    assertEqual(dragged.downTrusted, true, "dragAndDrop starts with trusted input");
    assertEqual(dragged.movesTrusted, true, "dragAndDrop movement stays trusted");
    assertEqual(dragged.upTrusted, true, "dragAndDrop ends with trusted input");

    const canvas = await page.evaluate(() => {
      const rect = document.querySelector("#drawing-canvas").getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    const curve = [
      [70, 85],
      [135, 35],
      [215, 45],
      [285, 105],
      [360, 125],
    ];
    await page.mouse.move(canvas.left + curve[0][0], canvas.top + curve[0][1]);
    await page.mouse.down();
    for (const [x, y] of curve.slice(1)) {
      await page.mouse.move(canvas.left + x, canvas.top + y, { steps: 4 });
    }
    await page.mouse.up();

    const polyline = [
      [90, 230],
      [230, 165],
      [390, 245],
      [570, 175],
    ];
    await page.mouse.move(canvas.left + polyline[0][0], canvas.top + polyline[0][1]);
    await page.mouse.down();
    for (const [x, y] of polyline.slice(1)) {
      await page.mouse.move(canvas.left + x, canvas.top + y);
    }
    await page.mouse.up();

    const drawing = await page.evaluate(() => window.__pointerWorkbench.read().drawing);
    assertEqual(drawing.strokes.length, 2, "canvas records one curved stroke and one polyline");
    assert(
      drawing.strokes[0].points.length >= 17,
      "the curved stroke receives intermediate mousemove steps"
    );
    assertEqual(
      drawing.strokes[1].points.length,
      polyline.length,
      "the polyline receives its explicit vertices"
    );
    assertEqual(drawing.allButtonsHeld, true, "canvas moves retain the pressed left button");
    assertEqual(drawing.allTrusted, true, "canvas drawing uses trusted mouse input throughout");
    assert(
      drawing.strokes.every((stroke) => stroke.downTrusted && stroke.upTrusted),
      "both canvas strokes have trusted down and up boundaries"
    );
    assert(drawing.inkPixels > 1000, "canvas contains a substantial amount of drawn ink");
    assert(
      drawing.inkBounds.minX < 80 && drawing.inkBounds.maxX > 560 &&
        drawing.inkBounds.minY < 50 && drawing.inkBounds.maxY > 235,
      "drawn pixels span the expected curve and polyline regions"
    );

    await page.screenshot({ path: afterPath });
    const before = await readFile(beforePath);
    const after = await readFile(afterPath);
    assert(before.length > 100 && after.length > 100, "visual artifacts contain PNG data");
    assert(!before.equals(after), "dragging and drawing visibly change the rendered page");

    await page.close();
  `;
}
