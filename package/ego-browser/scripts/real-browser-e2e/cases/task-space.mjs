export function taskSpaceCase() {
  return `
    const task = await useOrCreateTaskSpace(taskName);
    assertEqual(task.name, taskName, "useOrCreateTaskSpace selects named task");

    const reusedTask = await useOrCreateTaskSpace(taskName);
    assertEqual(reusedTask.id, task.id, "useOrCreateTaskSpace reuses an existing named task");

    const spaces = await listTaskSpaces();
    assert(spaces.some((space) => space.name === taskName), "listTaskSpaces includes e2e task");
    const listed = spaces.find((space) => space.name === taskName);
    assertEqual(typeof listed.id, "number", "listTaskSpaces returns numeric ids");
    assertEqual(listed.taskId !== undefined, true, "listTaskSpaces returns taskId");
    assertEqual(typeof listed.ownership, "string", "listTaskSpaces returns ownership");

    const switched = await switchTaskSpace(task.id);
    assertEqual(switched.id, task.id, "switchTaskSpace selects by numeric id");
    const switchedByName = await switchTaskSpace(taskName);
    assertEqual(switchedByName.id, task.id, "switchTaskSpace selects by name");
    const switchedByNumericString = await switchTaskSpace(String(task.id));
    assertEqual(switchedByNumericString.id, task.id, "switchTaskSpace selects by numeric string id");

    await waitForAgentControl(taskName, { interval: 0.1, timeout: 3 });
    await takeOverTaskSpace();
    await waitForAgentControl(taskName, { interval: 0.1, timeout: 3 });

    const scratch = await newTaskSpace(taskName + " scratch");
    assertEqual(scratch.name, taskName + " scratch", "newTaskSpace creates a scratch space");
    const scratchByName = await switchTaskSpace(scratch.name);
    assertEqual(scratchByName.id, scratch.id, "newTaskSpace output can be selected by name");
    const closed = await completeTaskSpace(scratch.id, { keep: false });
    assertEqual(closed.done, true, "completeTaskSpace closes scratch task");

    await assertRejects(
      () => completeTaskSpace(scratch.id, { keep: false }),
      "task space not found",
      "completeTaskSpace reports already-closed task space"
    );

    await switchTaskSpace(taskName);
    await assertRejects(
      () => switchTaskSpace(taskName + " missing"),
      "task space not found",
      "switchTaskSpace reports missing task space"
    );
    await assertRejects(
      () => useOrCreateTaskSpace(99999999),
      "task space not found",
      "useOrCreateTaskSpace rejects missing numeric id"
    );
    await assertRejects(
      () => completeTaskSpace(taskName, {}),
      "requires { keep: boolean }",
      "completeTaskSpace validates keep option"
    );
    await assertRejects(
      () => completeTaskSpace("", { keep: false }),
      "requires a task space name or id",
      "completeTaskSpace validates empty task id"
    );
    await assertRejects(
      () => waitForAgentControl("", { timeout: 0.1 }),
      "requires a task space name or id",
      "waitForAgentControl validates task space id"
    );
    await assertRejects(
      () => takeOverTaskSpace(taskName + " missing"),
      "task space not found",
      "takeOverTaskSpace reports missing task space"
    );
    await assertRejects(
      () => claimTaskSpace(taskName + " missing"),
      "task space not found",
      "claimTaskSpace reports missing task space"
    );
    await assertRejects(
      () => handOffTaskSpace(taskName + " missing"),
      "task space not found",
      "handOffTaskSpace reports missing task space"
    );

    await handOffTaskSpace();
    await takeOverTaskSpace();
    await waitForAgentControl(taskName, { interval: 0.1, timeout: 5 });
    const v2Task = await taskSpace(taskName + " v2 lifecycle");
    await v2Task.page("p1").goto(baseUrl + "/secondary?v2-lifecycle=handoff");
    await v2Task.handOff();
    const resumedTask = await takeOverTaskSpace(v2Task.spaceId);
    await resumedTask.waitForControl({ interval: 100, timeout: 5_000 });
    const boundaryPage = resumedTask.userPage();
    assert(Boolean(boundaryPage), "takeover captures the tab active at the user boundary");
    const handedOffSpaceId = resumedTask.spaceId;
    const keepAllReceipt = await resumedTask.finish({ keep: "all" });
    assertEqual(keepAllReceipt.spaceId, handedOffSpaceId, "task.finish receipt identifies its space");
    assertEqual(keepAllReceipt.closedSpace, false, "keep all reports that the space remains open");
    assert(
      keepAllReceipt.keptManagedLabels.includes(boundaryPage.label),
      "keep all receipt lists the retained managed Page"
    );
    assertEqual(keepAllReceipt.closedManagedLabels.length, 0, "keep all receipt reports no managed Page closures");
    assert(
      (await listTaskSpaces()).some((space) => space.id === handedOffSpaceId),
      "task.finish keeps the handed-off browser space"
    );
    await completeTaskSpace(handedOffSpaceId, { keep: false });

    const closeTask = await taskSpace(taskName + " v2 close through finish");
    const closeSpaceId = closeTask.spaceId;
    const closeReceipt = await closeTask.finish({ keep: [] });
    assertEqual(closeReceipt.spaceId, closeSpaceId, "close receipt identifies its space");
    assertEqual(closeReceipt.closedSpace, true, "empty keep reports that the whole space closed");
    assertEqual(closeReceipt.keptManagedLabels.length, 0, "closed-space receipt reports no retained managed Pages");
    assert(closeReceipt.closedManagedLabels.length > 0, "closed-space receipt lists the managed Pages it closed");
    assertEqual(closeReceipt.preservedUnmanagedCount, 0, "closed-space receipt reports no protected unmanaged tabs");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await listTaskSpaces()).some((space) => space.id === closeSpaceId)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(
      !(await listTaskSpaces()).some((space) => space.id === closeSpaceId),
      "task.finish with no retained Pages removes the v2 task space"
    );

    const finishTask = await taskSpace(taskName + " v2 finish");
    await finishTask.page("p1").goto(baseUrl + "/secondary?v2-lifecycle=discard");
    const retainedPage = await finishTask.newPage();
    await retainedPage.goto(baseUrl + "/secondary?v2-lifecycle=retain");
    const finishSpaceId = finishTask.spaceId;
    const namedReceipt = await finishTask.finish({ keep: [retainedPage.label] });
    assertEqual(namedReceipt.closedSpace, false, "named retention reports that the space remains open");
    assertEqual(
      JSON.stringify(namedReceipt.keptManagedLabels),
      JSON.stringify([retainedPage.label]),
      "named retention receipt lists the retained Page"
    );
    assert(
      namedReceipt.closedManagedLabels.includes("p1"),
      "named retention receipt lists the discarded Agent Page"
    );
    assertEqual(namedReceipt.preservedUnmanagedCount, 0, "named retention reports no unmanaged tabs");
    assert(
      (await listTaskSpaces()).some((space) => space.id === finishSpaceId),
      "task.finish keeps the browser space when one Page is retained"
    );
    const reclaimedFinishedTask = await claimTaskSpace(finishSpaceId);
    const retainedTabs = await reclaimedFinishedTask.tabs();
    assert(
      retainedTabs.some((tab) => tab.url.includes("v2-lifecycle=retain")),
      "task.finish keeps the named Page"
    );
    assert(
      !retainedTabs.some((tab) => tab.url.includes("v2-lifecycle=discard")),
      "task.finish closes unlisted Agent Pages"
    );
    await completeTaskSpace(finishSpaceId, { keep: false });
  `;
}

export function crossSpaceV2Case() {
  return `
    const firstTask = await taskSpace(taskName + " gate first");
    const firstPage = firstTask.page("p1");
    await firstPage.goto(baseUrl + "/?space=first");
    const secondTask = await taskSpace(taskName + " gate second");
    const secondPage = secondTask.page("p1");
    await secondPage.goto(baseUrl + "/secondary?space=second");

    const [firstInfo, secondInfo] = await Promise.all([
      firstPage.info(),
      secondPage.info(),
    ]);
    assertIncludes(firstInfo.url, "space=first", "cross-space gate keeps the first request in its space");
    assertIncludes(secondInfo.url, "space=second", "cross-space gate keeps the second request in its space");

    await firstTask.finish({ keep: [] });
    await secondTask.finish({ keep: [] });
  `;
}
