const nativeHost = "com.citrolabs.ego.gpu_mode";

chrome.runtime.onStartup.addListener(() => {
  chrome.runtime.sendNativeMessage(nativeHost, { action: "ensureMode" }, () => {
    void chrome.runtime.lastError;
  });
});
