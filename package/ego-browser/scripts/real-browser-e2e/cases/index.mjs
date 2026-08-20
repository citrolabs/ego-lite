import { environmentCase } from "./environment.mjs";
import { helperSurfaceCase } from "./helper-surface.mjs";
import { taskSpaceCase } from "./task-space.mjs";
import { navigationCase } from "./navigation.mjs";
import { observationCase } from "./observation.mjs";
import {
  pointerClickCase,
  pointerHoverDragCase,
  pointerInteractionRegressionCase,
  pointerValidationCase,
  scrollHelpersCase,
} from "./pointer.mjs";
import { keyboardCase } from "./keyboard.mjs";
import { keyboardRegressionCase } from "./keyboard-regression.mjs";
import { fillEditabilityCases } from "./fill-editability.mjs";
import { macosInputRegressionCase } from "./macos-input-regression.mjs";
import {
  cdpJsHelpCase,
  fetchHelpersCase,
  waitHelpersCase,
} from "./runtime.mjs";
import { runtimeRegressionCase } from "./runtime-regression.mjs";
import { adversarialCases } from "./adversarial.mjs";
import { workflowCases } from "./workflows.mjs";
import { interactionsCases } from "./interactions.mjs";
import { canvasCases } from "./canvas.mjs";
import { downloadCases } from "./downloads.mjs";
import { playwrightUrlWaitCases } from "./playwright-url-waits.mjs";
import { playwrightPageUrlCases } from "./playwright-page-url.mjs";
import { playwrightPageInfoCases } from "./playwright-page-info.mjs";
import { playwrightLocatorCases } from "./playwright-locators.mjs";
import { playwrightTargetCases } from "./playwright-targets.mjs";
import { playwrightPermissionCases } from "./playwright-permissions.mjs";
import { damaiRushCase } from "./damai-rush.mjs";
import { videoRecordingCase } from "./video-recording.mjs";

export const e2eCases = [
  { name: "environment initialization", body: environmentCase },
  { name: "helper surface", body: helperSurfaceCase },
  { name: "task spaces and control", body: taskSpaceCase },
  { name: "navigation helpers", body: navigationCase },
  { name: "observation helpers", body: observationCase },
  { name: "pointer click helpers", body: pointerClickCase },
  { name: "pointer hover drag helpers", body: pointerHoverDragCase },
  { name: "scroll helpers", body: scrollHelpersCase },
  { name: "pointer validation", body: pointerValidationCase },
  {
    name: "pointer interaction regression",
    body: pointerInteractionRegressionCase,
  },
  { name: "keyboard and file helpers", body: keyboardCase },
  { name: "keyboard regression", body: keyboardRegressionCase },
  {
    name: "macOS bare Meta input isolation",
    body: macosInputRegressionCase,
  },
  { name: "wait helpers", body: waitHelpersCase },
  { name: "fetch helpers", body: fetchHelpersCase },
  { name: "cdp js help", body: cdpJsHelpCase },
  { name: "runtime regression", body: runtimeRegressionCase },
  { name: "screencast recording", body: videoRecordingCase },
  { name: "concert ticket rush", body: damaiRushCase },
  ...fillEditabilityCases,
  ...adversarialCases,
  ...workflowCases,
  ...downloadCases,
  ...interactionsCases,
  ...canvasCases,
  ...playwrightUrlWaitCases,
  ...playwrightPageUrlCases,
  ...playwrightPageInfoCases,
  ...playwrightLocatorCases,
  ...playwrightTargetCases,
  ...playwrightPermissionCases,
];
