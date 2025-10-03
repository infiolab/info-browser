/* eslint-disable */
/**
 * Excalidraw 控制脚本（注入页面执行）
 *
 * 目的：
 * - 在已加载的 Excalidraw 应用中，遍历 React Fiber 树，提取 `excalidrawAPI`
 * - 通过自定义事件 `chrome-mcp:*` 提供对画布的编程控制
 *
 * 对外暴露的动作（通过派发 `excalidraw:execute` 事件调用；兼容 `chrome-mcp:execute`）：
 * - getSceneElements：获取画布上所有元素的完整数据
 * - addElement：向画布添加一个或多个新元素
 * - updateElement：修改画布的一个或多个元素
 * - deleteElement：根据元素 ID 删除元素
 * - cleanup：清空重置画布
 *
 * 通信约定：
 * - 入站事件：`excalidraw:execute`（兼容 `chrome-mcp:execute`），detail: { action, payload(JSON 字符串), requestId }
 * - 出站事件：`excalidraw:response`（同时兼容派发 `chrome-mcp:response`），detail: { requestId, data, error }
 */
(() => {
  const SCRIPT_ID = 'excalidraw-control-script';
  if (window[SCRIPT_ID]) {
    return;
  }
  /**
   * 从 DOM 节点出发，借助 React 内部属性找到 Excalidraw 的 API 实例。
   * 查找策略：
   * 1) 从 DOM 上的 __reactFiber$* / __reactInternalInstance$* 进入 Fiber 节点
   * 2) 依次在 fiber.stateNode.props、fiber.memoizedProps、fiber.stateNode.state、fiber.stateNode 等容器里深搜
   * 3) 针对函数组件/高阶组件/ForwardRef/Memo/Lazy 等，沿 hooks 链 (memoizedState) 深搜
   * 4) 也检查 Context 相关的 memoizedProps.value
   * 5) 最多尝试 MAX_TRAVERSAL_ATTEMPTS 次向上回溯父节点
   * 成功则把实例挂到 window.excalidrawAPI，并返回该实例；失败返回 null。
   */
  function getExcalidrawAPIFromDOM(domElement) {
    if (!domElement) {
      return null;
    }
    // 尝试从 DOM 上的 React 内部标识拿到 Fiber 根引用
    const reactFiberKey = Object.keys(domElement).find(
      key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
    );
    if (!reactFiberKey) {
      return null;
    }
    let fiberNode = domElement[reactFiberKey];
    if (!fiberNode) {
      return null;
    }
    // 粗略判定对象是否形似 excalidrawAPI（鸭子类型）
    function isExcalidrawAPI(obj) {
      return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.updateScene === 'function' &&
        typeof obj.getSceneElements === 'function' &&
        typeof obj.getAppState === 'function'
      );
    }
    // 在任意对象里做浅-深混合查找（有限递归）
    function findApiInObject(objToSearch) {
      if (isExcalidrawAPI(objToSearch)) {
        return objToSearch;
      }
      if (typeof objToSearch === 'object' && objToSearch !== null) {
        for (const key in objToSearch) {
          if (Object.prototype.hasOwnProperty.call(objToSearch, key)) {
            const found = findApiInObject(objToSearch[key]);
            if (found) {
              return found;
            }
          }
        }
      }
      return null;
    }
    let excalidrawApiInstance = null;
    let attempts = 0;
    const MAX_TRAVERSAL_ATTEMPTS = 25;
    // 自底向上遍历 Fiber，逐层回溯父节点，并在不同可能的挂载点上尝试查找 API
    while (fiberNode && attempts < MAX_TRAVERSAL_ATTEMPTS) {
      // 情况 1：类组件/大多数组件的 props 中
      if (fiberNode.stateNode && fiberNode.stateNode.props) {
        const api = findApiInObject(fiberNode.stateNode.props);
        if (api) {
          excalidrawApiInstance = api;
          break;
        }
        if (isExcalidrawAPI(fiberNode.stateNode.props.excalidrawAPI)) {
          excalidrawApiInstance = fiberNode.stateNode.props.excalidrawAPI;
          break;
        }
      }
      // 情况 2：函数组件/记忆化组件的 memoizedProps 中
      if (fiberNode.memoizedProps) {
        const api = findApiInObject(fiberNode.memoizedProps);
        if (api) {
          excalidrawApiInstance = api;
          break;
        }
        if (isExcalidrawAPI(fiberNode.memoizedProps.excalidrawAPI)) {
          excalidrawApiInstance = fiberNode.memoizedProps.excalidrawAPI;
          break;
        }
      }

      // 情况 3：类组件的 state 中
      if (fiberNode.tag === 1 && fiberNode.stateNode && fiberNode.stateNode.state) {
        const api = findApiInObject(fiberNode.stateNode.state);
        if (api) {
          excalidrawApiInstance = api;
          break;
        }
      }

      // 情况 4：函数组件/ForwardRef/Memo/Lazy 等，通过 hooks 链 (memoizedState) 查找
      if (
        fiberNode.tag === 0 ||
        fiberNode.tag === 2 ||
        fiberNode.tag === 14 ||
        fiberNode.tag === 15 ||
        fiberNode.tag === 11
      ) {
        if (fiberNode.memoizedState) {
          let currentHook = fiberNode.memoizedState;
          let hookAttempts = 0;
          const MAX_HOOK_ATTEMPTS = 15;
          while (currentHook && hookAttempts < MAX_HOOK_ATTEMPTS) {
            const api = findApiInObject(currentHook.memoizedState);
            if (api) {
              excalidrawApiInstance = api;
              break;
            }
            currentHook = currentHook.next;
            hookAttempts++;
          }
          if (excalidrawApiInstance) break;
        }
      }
      // 情况 5：某些场景下 API 可能直接挂到 stateNode 上
      if (fiberNode.stateNode) {
        const api = findApiInObject(fiberNode.stateNode);
        if (api && api !== fiberNode.stateNode.props && api !== fiberNode.stateNode.state) {
          excalidrawApiInstance = api;
          break;
        }
      }
      // 情况 6：Context 相关的 value
      if (fiberNode.tag === 9 && fiberNode.memoizedProps && typeof fiberNode.memoizedProps.value !== 'undefined') {
        const api = findApiInObject(fiberNode.memoizedProps.value);
        if (api) {
          excalidrawApiInstance = api;
          break;
        }
      }

      // 向上回溯
      if (fiberNode.return) {
        fiberNode = fiberNode.return;
      } else {
        break;
      }
      attempts++;
    }

    if (excalidrawApiInstance) {
      window.excalidrawAPI = excalidrawApiInstance;
      // 注意：这里的提示字符串中的名称 `window.foundExcalidrawAPI` 与实际绑定的变量名
      // `window.excalidrawAPI` 不一致，仅为提示信息，不影响功能。
      console.log('现在您可以通过 `window.foundExcalidrawAPI` 在控制台访问它。');
    } else {
      console.error('在检查组件树后未能找到 excalidrawAPI。');
    }
    return excalidrawApiInstance;
  }

  /**
   * 把一个“元素骨架”补全为可被 Excalidraw 接受的完整元素对象。
   * - 会生成 id / seed / versionNonce / updated 等必要字段
   * - 使用一组默认属性填充未提供的字段
   *
   * @param {Object} skeleton 来自外部的元素部分字段
   * @returns {Object} 可直接加入场景的 Excalidraw 元素对象
   */
  function createFullExcalidrawElement(skeleton) {
    // 简单随机生成一个短 id。生产中如需稳定性，可改为更可靠的 uuid。
    const id = Math.random().toString(36).substring(2, 9);

    const seed = Math.floor(Math.random() * 2 ** 31);
    const versionNonce = Math.floor(Math.random() * 2 ** 31);

    // Excalidraw 元素常见默认属性
    const defaults = {
      isDeleted: false,
      fillStyle: 'hachure',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      angle: 0,
      groupIds: [],
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      version: 1,
      locked: false,
    };

    const fullElement = {
      id: id,
      seed: seed,
      versionNonce: versionNonce,
      updated: Date.now(),
      ...defaults,
      ...skeleton,
    };

    return fullElement;
  }

  let targetElementForAPI = document.querySelector('.excalidraw-app');

  if (targetElementForAPI) {
    // 页面中若已存在 excalidraw 容器，启动时即尝试绑定 API
    getExcalidrawAPIFromDOM(targetElementForAPI);
  }

  // 对外暴露的动作处理器。通过 `chrome-mcp:execute` 指定 action 触发下列方法。
  const eventHandler = {
    /**
     * getSceneElements：获取画布上所有元素的完整数据
     * @returns {Array|{error:boolean,msg:string}} 元素数组或错误信息
     */
    getSceneElements: () => {
      try {
        return window.excalidrawAPI.getSceneElements();
      } catch (error) {
        return {
          error: true,
          msg: JSON.stringify(error),
        };
      }
    },
    /**
     * addElement：向画布添加一个或多个新元素
     * @param {{ eles: Array<Object> }} param 传入元素“骨架”数组，内部会补全为完整元素
     * @returns {{success:true}|{error:true,msg:string}}
     */
    addElement: param => {
      try {
        // 读取现有元素，复制一份进行不可变更新
        const existingElements = window.excalidrawAPI.getSceneElements();
        const newElements = [...existingElements];
        // 逐个补全并压入新元素。这里额外写入了一个自定义的 index 字段，
        // 仅作为示例/排序使用，Excalidraw 并不强制要求该字段。
        param.eles.forEach((ele, idx) => {
          const newEle = createFullExcalidrawElement(ele);
          newEle.index = `a${existingElements.length + idx + 1}`;
          newElements.push(newEle);
        });
        console.log('newElements ==>', newElements);
        const appState = window.excalidrawAPI.getAppState();
        // 通过 updateScene 写回，并记录到历史（可撤销/重做）
        window.excalidrawAPI.updateScene({
          elements: newElements,
          appState: appState,
          commitToHistory: true,
        });
        return {
          success: true,
        };
      } catch (error) {
        return {
          error: true,
          msg: JSON.stringify(error),
        };
      }
    },
    /**
     * deleteElement：根据元素 ID 删除元素
     * @param {{ id: string }} param 要删除的元素 ID
     * @returns {{success:true}|{error:true,msg:string}}
     */
    deleteElement: param => {
      try {
        const existingElements = window.excalidrawAPI.getSceneElements();
        const newElements = [...existingElements];
        const idx = newElements.findIndex(e => e.id === param.id);
        if (idx >= 0) {
          newElements.splice(idx, 1);
          const appState = window.excalidrawAPI.getAppState();
          // 同样使用 updateScene 写回，并记录历史
          window.excalidrawAPI.updateScene({
            elements: newElements,
            appState: appState,
            commitToHistory: true,
          });
          return {
            success: true,
          };
        } else {
          return {
            error: true,
            msg: 'element not found',
          };
        }
      } catch (error) {
        return {
          error: true,
          msg: JSON.stringify(error),
        };
      }
    },
    /**
     * updateElement：修改画布的一个或多个元素
     * @param {Array<{id:string}>} param 要更新的元素（数组），每个对象须包含 id，其它字段为要变更的属性
     * @returns {{success:true,msg?:string}|{error:true,msg:string}}
     */
    updateElement: param => {
      try {
        const existingElements = window.excalidrawAPI.getSceneElements();
        const resIds = [];
        for (let i = 0; i < param.length; i++) {
          const idx = existingElements.findIndex(e => e.id === param[i].id);
          if (idx >= 0) {
            resIds.push(param[i].id);
            // Excalidraw 提供的 mutateElement 可对既有元素进行原位变更
            window.excalidrawAPI.mutateElement(existingElements[idx], { ...param[i] });
          }
        }
        return {
          success: true,
          msg: `已更新元素：${resIds.join(',')}`,
        };
      } catch (error) {
        return {
          error: true,
          msg: JSON.stringify(error),
        };
      }
    },
    /**
     * cleanup：清空重置画布（不保留任何元素）
     * @returns {{success:true}|{error:true,msg:string}}
     */
    cleanup: () => {
      try {
        // resetScene 会清空元素集合，相当于新建空白画布
        window.excalidrawAPI.resetScene();
        return {
          success: true,
        };
      } catch (error) {
        return {
          error: true,
          msg: JSON.stringify(error),
        };
      }
    },
  };

  /**
   * 事件执行入口：接收 `chrome-mcp:execute`，根据 action 调用对应处理器，
   * 并通过 `chrome-mcp:response` 回传执行结果。
   */
  const handleExecution = event => {
    const { action, payload, requestId } = event.detail;
    const param = JSON.parse(payload || '{}');
    let data, error;
    try {
      const handler = eventHandler[action];
      if (!handler) {
        error = 'event name not found';
      }
      data = handler(param);
    } catch (e) {
      error = e.message;
    }
    // 首选 excalidraw:* 响应事件；为兼容现有桥接，也同步派发 chrome-mcp:*
    const detail = { requestId, data, error };
    window.dispatchEvent(new CustomEvent('excalidraw:response', { detail }));
    window.dispatchEvent(new CustomEvent('chrome-mcp:response', { detail }));
  };

  // --- Lifecycle Functions ---
  /**
   * 初始化：注册事件监听，并设置脚本注入守卫标记。
   */
  const initialize = () => {
    // 新事件通道
    window.addEventListener('excalidraw:execute', handleExecution);
    window.addEventListener('excalidraw:cleanup', cleanup);
    // 兼容旧事件通道
    window.addEventListener('chrome-mcp:execute', handleExecution);
    window.addEventListener('chrome-mcp:cleanup', cleanup);
    window[SCRIPT_ID] = true;
  };

  /**
   * 反初始化：移除事件监听并清理全局引用。
   * 注意：此处的 cleanup（生命周期）与上面的 eventHandler.cleanup（重置画布）概念不同。
   */
  const cleanup = () => {
    // 新旧事件通道均解除
    window.removeEventListener('excalidraw:execute', handleExecution);
    window.removeEventListener('excalidraw:cleanup', cleanup);
    window.removeEventListener('chrome-mcp:execute', handleExecution);
    window.removeEventListener('chrome-mcp:cleanup', cleanup);
    delete window[SCRIPT_ID];
    delete window.excalidrawAPI;
  };

  initialize();
})();
