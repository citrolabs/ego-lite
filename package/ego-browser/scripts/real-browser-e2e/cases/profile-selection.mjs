export function profileSelectionCase() {
  return `
    const availableProfiles = await profiles();
    assert(availableProfiles.length > 0, "profiles returns at least one browser profile");
    assert(
      availableProfiles.every(
        (profile) =>
          typeof profile.id === "string" &&
          profile.id.length > 0 &&
          typeof profile.name === "string" &&
          typeof profile.isDefault === "boolean"
      ),
      "profiles returns complete profile descriptors"
    );
    assertEqual(
      new Set(availableProfiles.map((profile) => profile.id)).size,
      availableProfiles.length,
      "profiles returns unique profile ids"
    );

    const selectedProfile =
      availableProfiles.find((profile) => !profile.isDefault) || availableProfiles[0];
    const explicitName = taskName + " explicit profile";
    const explicitTask = await taskSpace(explicitName, {
      profileId: selectedProfile.id,
    });
    try {
      const initialTabs = await explicitTask.tabs();
      assertEqual(initialTabs.length, 1, "a new TaskSpace starts with one tab");
      assertEqual(initialTabs[0].label, "p1", "the initial tab is managed as p1");
      assertEqual(initialTabs[0].openedBy, "agent", "the initial tab is Agent-owned");
      const initialTargetId = initialTabs[0].targetId;

      const page = explicitTask.page("p1");
      await page.goto(baseUrl + "/?profile=explicit");
      assertEqual(
        await page.title(),
        "ego-lite helper e2e",
        "the selected Profile TaskSpace is operable"
      );
      const navigatedTabs = await explicitTask.tabs();
      assertEqual(navigatedTabs.length, 1, "using p1 does not create another tab");
      assertEqual(
        navigatedTabs[0].targetId,
        initialTargetId,
        "p1 keeps the native initial target"
      );

      await assertRejects(
        () => taskSpace(explicitName, { profileId: selectedProfile.id }),
        "already exists",
        "explicit profile selection never reuses a same-name TaskSpace"
      );
      await assertRejects(
        () => taskSpace(explicitTask.spaceId, { profileId: selectedProfile.id }),
        "new task-space name",
        "profile selection cannot be applied while resuming a numeric space id"
      );
    } finally {
      await explicitTask.close();
    }

    let missingProfileId = "__ego_browser_missing_profile__";
    while (availableProfiles.some((profile) => profile.id === missingProfileId)) {
      missingProfileId += "_";
    }
    const invalidName = taskName + " invalid profile";
    await assertRejects(
      () => taskSpace(invalidName, { profileId: missingProfileId }),
      "Profile not found",
      "an unknown profile is reported by Ego Lite"
    );
    assert(
      !(await listTaskSpaces()).some((space) => space.name === invalidName),
      "an unknown profile does not leave a TaskSpace"
    );
  `;
}
