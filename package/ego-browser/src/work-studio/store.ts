import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WorkStudioTabRole = "result_studio" | "interactive_source" | "information_source" | "temporary";

export type WorkStudioTab = {
  id?: string;
  role?: WorkStudioTabRole;
  targetId?: string;
  url?: string;
  title?: string;
  reason?: string;
  keepAlive?: boolean;
  archived?: boolean;
  restoreable?: boolean;
};

export type WorkStudioItem = {
  id: string;
  title?: string;
  url?: string;
  sourceTabId?: string;
  [key: string]: unknown;
};

export type WorkStudioBindingStep =
  | { type: "switch_tab"; targetId?: string }
  | { type: "open_url"; url?: string; wait?: boolean }
  | { type: "click"; selector?: string; locator?: string }
  | { type: "fill"; selector?: string; locator?: string; value?: string }
  | { type: "wait"; seconds?: number }
  | { type: "eval"; expression: string };

export type WorkStudioBinding = {
  id: string;
  itemId?: string;
  sourceTabId?: string;
  label?: string;
  type?: "click_bound" | "run_sequence";
  selector?: string;
  locator?: string;
  steps?: WorkStudioBindingStep[];
};

export type WorkStudioDocument = {
  title?: string;
  subtitle?: string;
  summary?: string;
  sections?: Array<Record<string, unknown>>;
  items?: WorkStudioItem[];
};

export type WorkStudioA2UI = {
  version?: string;
  surfaceId?: string;
  messages?: unknown[];
};

export type WorkStudioSpec = {
  taskId: string;
  title?: string;
  mode?: "interactive-action" | "research-summary" | "mixed" | string;
  a2ui?: WorkStudioA2UI;
  document?: WorkStudioDocument;
  data?: Record<string, unknown>;
  tabs?: WorkStudioTab[];
  items?: WorkStudioItem[];
  bindings?: WorkStudioBinding[];
  tabPolicy?: {
    closeInformationTabs?: boolean;
    closeTemporaryTabs?: boolean;
    keepInteractiveTabs?: boolean;
  };
};

export type WorkStudioStoredTask = WorkStudioSpec & {
  safeTaskId: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  a2ui: WorkStudioA2UI & { version: string; surfaceId: string; messages: unknown[] };
  tabs: WorkStudioTab[];
  items: WorkStudioItem[];
  bindings: WorkStudioBinding[];
};

export function workStudioRoot() {
  return process.env.EGO_BROWSER_WORK_STUDIO_DIR || join(homedir(), ".ego-browser", "work-studio");
}

export function safeTaskId(taskId: string) {
  const slug = String(taskId || "task")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
  const hash = createHash("sha256").update(String(taskId)).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

export function taskDir(taskId: string) {
  return join(workStudioRoot(), safeTaskId(taskId));
}

export function serverInfoPath(taskId: string) {
  return join(taskDir(taskId), "server.json");
}

export async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readStoredTask(taskId: string): Promise<WorkStudioStoredTask> {
  return readJson(join(taskDir(taskId), "studio.json"));
}

export async function writeStoredTask(spec: WorkStudioSpec, existing?: Partial<WorkStudioStoredTask>) {
  if (!spec || typeof spec.taskId !== "string" || !spec.taskId) {
    throw new Error("createWorkStudio requires a non-empty taskId");
  }
  const now = new Date().toISOString();
  const safe = safeTaskId(spec.taskId);
  const stored: WorkStudioStoredTask = {
    ...spec,
    safeTaskId: safe,
    token: existing?.token || randomBytes(24).toString("base64url"),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    title: spec.title || spec.document?.title || "Work Studio",
    mode: spec.mode || "mixed",
    a2ui: normalizeA2UI(spec),
    tabs: normalizeTabs(spec.tabs || []),
    items: spec.items || spec.document?.items || [],
    bindings: spec.bindings || []
  };
  await writeJson(join(taskDir(spec.taskId), "studio.json"), stored);
  await writeJson(join(taskDir(spec.taskId), "bindings.json"), { bindings: stored.bindings });
  return stored;
}

export function normalizeTabs(tabs: WorkStudioTab[]) {
  return tabs.map((tab, index) => {
    const role = tab.role || "information_source";
    return {
      id: tab.id || `tab_${index + 1}`,
      role,
      targetId: tab.targetId,
      url: tab.url || "",
      title: tab.title || tab.url || `Tab ${index + 1}`,
      reason: tab.reason,
      keepAlive: tab.keepAlive ?? (role === "interactive_source" || role === "result_studio"),
      archived: tab.archived ?? (role === "information_source"),
      restoreable: tab.restoreable ?? Boolean(tab.url)
    };
  });
}

export function normalizeA2UI(spec: WorkStudioSpec) {
  const surfaceId = spec.a2ui?.surfaceId || "main";
  const messages = spec.a2ui?.messages?.length ? spec.a2ui.messages : documentToA2UI(spec, surfaceId);
  return {
    version: spec.a2ui?.version || "v0.9",
    surfaceId,
    messages
  };
}

function documentToA2UI(spec: WorkStudioSpec, surfaceId: string) {
  const components: Array<Record<string, unknown>> = [];
  const title = spec.title || spec.document?.title || "Work Studio";
  components.push({ id: "title", component: "Text", text: title, variant: "h1" });
  if (spec.document?.subtitle) {
    components.push({ id: "subtitle", component: "Text", text: spec.document.subtitle, variant: "subtitle" });
  }
  if (spec.document?.summary) {
    components.push({ id: "summary", component: "Text", text: spec.document.summary, variant: "body" });
  }
  const items = spec.items || spec.document?.items || [];
  for (const item of items) {
    const textId = `${item.id}_title`;
    components.push({ id: textId, component: "Text", text: item.title || item.id, variant: "h3" });
    components.push({
      id: `${item.id}_open`,
      component: "Button",
      text: "Open original",
      variant: "secondary",
      action: { event: { name: "open_original", context: { itemId: item.id } } }
    });
  }
  components.push({
    id: "history_toggle",
    component: "Button",
    text: "Show browsing history",
    variant: "secondary",
    action: { event: { name: "load_history", context: {} } }
  });
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: "work-studio/basic" } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { items, data: spec.data || {} } } }
  ];
}

export async function readServerInfo(taskId: string) {
  const path = serverInfoPath(taskId);
  if (!existsSync(path)) return null;
  return readJson(path);
}

export async function writeServerInfo(taskId: string, info: Record<string, unknown>) {
  await writeJson(serverInfoPath(taskId), info);
}
