const nativeHost = "com.citrolabs.ego.gpu_mode";
const modeNames = {
  normal: "正常",
  balanced: "均衡",
  "low-power": "低功耗",
  software: "软件渲染",
};

const currentMode = document.querySelector("#current-mode");
const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("[data-mode]")];
let renderedMode = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(nativeHost, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "本地服务返回了未知错误"));
        return;
      }
      resolve(response);
    });
  });
}

function renderMode(mode) {
  renderedMode = mode;
  currentMode.textContent = modeNames[mode] || "未知";
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
}

function setBusy(busy) {
  for (const button of buttons) {
    button.disabled = busy;
  }
}

async function loadStatus() {
  try {
    const response = await send({ action: "status" });
    renderMode(response.mode);
    if (response.mode === "low-power" && !response.active) {
      status.textContent = "低功耗参数尚未生效，正在自动重启。";
      await send({ action: "ensureMode" });
    }
  } catch (error) {
    status.className = "error";
    status.textContent = `无法连接本地服务：${error.message}`;
  }
}

for (const button of buttons) {
  button.addEventListener("click", async () => {
    const mode = button.dataset.mode;
    const previousMode = renderedMode;
    setBusy(true);
    status.className = "";
    status.textContent = "正在保存设置，ego lite 将自动重启…";
    try {
      renderMode(mode);
      await send({ action: "setMode", mode });
    } catch (error) {
      if (previousMode) {
        renderMode(previousMode);
      }
      setBusy(false);
      status.className = "error";
      status.textContent = `切换失败：${error.message}`;
    }
  });
}

void loadStatus();
