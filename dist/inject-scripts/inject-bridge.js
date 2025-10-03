/* eslint-disable */

(() => {
  // Prevent duplicate injection of the bridge itself.
  if (window.__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__) return;
  window.__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__ = true;
  const EVENT_NAME = {
    // 兼容旧通道
    RESPONSE: 'chrome-mcp:response',
    CLEANUP: 'chrome-mcp:cleanup',
    EXECUTE: 'chrome-mcp:execute',
    // 新通道（excalidraw 专用）
    EX_RESPONSE: 'excalidraw:response',
    EX_CLEANUP: 'excalidraw:cleanup',
    EX_EXECUTE: 'excalidraw:execute',
  };
  const pendingRequests = new Map();

  const messageHandler = (request, _sender, sendResponse) => {
    // --- Lifecycle Command ---
    if (request.type === EVENT_NAME.CLEANUP || request.type === EVENT_NAME.EX_CLEANUP) {
      // 同步派发新旧两种 cleanup 事件
      window.dispatchEvent(new CustomEvent(EVENT_NAME.CLEANUP));
      window.dispatchEvent(new CustomEvent(EVENT_NAME.EX_CLEANUP));
      // Acknowledge cleanup signal received, but don't hold the connection.
      sendResponse({ success: true });
      return true;
    }

    // --- Execution Command for MAIN world ---
    if (request.targetWorld === 'MAIN') {
      const requestId = `req-${Date.now()}-${Math.random()}`;
      pendingRequests.set(requestId, sendResponse);

      // 同步派发新旧两种 execute 事件，允许页面脚本任选其一监听
      const detail = { action: request.action, payload: request.payload, requestId };
      window.dispatchEvent(new CustomEvent(EVENT_NAME.EXECUTE, { detail }));
      window.dispatchEvent(new CustomEvent(EVENT_NAME.EX_EXECUTE, { detail }));
      return true; // Async response is expected.
    }
    // Note: Requests for ISOLATED world are handled by the user's isolatedWorldCode script directly.
    // This listener won't process them unless it's the only script in ISOLATED world.
  };

  chrome.runtime.onMessage.addListener(messageHandler);

  // Listen for responses coming back from the MAIN world.
  const responseHandler = event => {
    const { requestId, data, error } = event.detail;
    if (pendingRequests.has(requestId)) {
      const sendResponse = pendingRequests.get(requestId);
      sendResponse({ data, error });
      pendingRequests.delete(requestId);
    }
  };
  // 同时监听新旧两种响应事件
  window.addEventListener(EVENT_NAME.RESPONSE, responseHandler);
  window.addEventListener(EVENT_NAME.EX_RESPONSE, responseHandler);

  // --- Self Cleanup ---
  // When the cleanup signal arrives, this bridge must also clean itself up.
  const cleanupHandler = () => {
    chrome.runtime.onMessage.removeListener(messageHandler);
    window.removeEventListener(EVENT_NAME.RESPONSE, responseHandler);
    window.removeEventListener(EVENT_NAME.EX_RESPONSE, responseHandler);
    window.removeEventListener(EVENT_NAME.CLEANUP, cleanupHandler);
    window.removeEventListener(EVENT_NAME.EX_CLEANUP, cleanupHandler);
    delete window.__INJECT_SCRIPT_TOOL_UNIVERSAL_BRIDGE_LOADED__;
  };
  window.addEventListener(EVENT_NAME.CLEANUP, cleanupHandler);
  window.addEventListener(EVENT_NAME.EX_CLEANUP, cleanupHandler);
})();
