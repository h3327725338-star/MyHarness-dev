// Files the Agent gives a web page, and the page's file chooser while the Agent works on a tab.
//
// A page asks for files in two ways: an <input type="file"> it already has, or a button whose handler makes one and
// opens the system's "Open" window (Teams' "Upload from this device", Gmail's paperclip, most chat apps). The Agent
// cannot answer a system window, and in a tab it drives in the background such a window held up every later command
// (the Agent's calls ran into the host's 60 s limit). So while the Agent acts on a tab, the tab's choosers are taken
// over through DevTools (`Page.setInterceptFileChooserDialog`): no window opens, the page's request is kept, and the
// `upload` command answers it with `DOM.setFileInputFiles`. Pages inside cross-origin frames (Teams' assignments page)
// are separate DevTools targets; they are attached as they appear (`Target.setAutoAttach`, flat sessions), get the same
// takeover, and are searched for the button and for file inputs.
//
// The takeover ends AGENT_AWAKE_MS after the Agent's last action on the tab, or as soon as a person clicks or types in
// it, so the user's own upload buttons open the normal window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** One upload: at most this many files, each at most MAX_FILE_BYTES, together at most MAX_TOTAL_BYTES. */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
/** A chooser the Agent's own click opened stays usable by an `upload` without a target for this long. */
const CHOOSER_KEEP_MS = 120000;
/** How long `upload` waits for the chooser after pressing a button. */
const CHOOSER_WAIT_MS = 4000;

// Places under the user's folder that hold sign-ins, keys and app data. A web page (or a prompt it carries) must not be
// able to make the Agent send them anywhere, so they stay out of reach even though the rest of the folder is allowed.
// Matched on the first path parts below the user's folder, without regard to case.
const BLOCKED_UNDER_HOME = [
  ['.ssh'], ['.gnupg'], ['.myharness'], ['.aws'], ['.azure'], ['.kube'], ['.docker'], ['.claude'], ['.codex'], ['.dsh'],
  ['.config'], ['.local'], ['.vscode'], ['.cursor'], ['.git-credentials'], ['.netrc'], ['_netrc'], ['.npmrc'], ['.pypirc'],
  ['.gitconfig'], ['.bash_history'], ['.wslconfig'], ['AppData'],
];
// AppData is blocked, except the temporary folder: programs (and the Agent) build files there before they are sent.
const ALLOWED_UNDER_HOME = [['AppData', 'Local', 'Temp']];
// Key and secret files by name, wherever they sit outside the chat's own folders.
const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|\.env(\..+)?|credentials(\.json)?|.+\.(pem|key|pfx|p12|kdbx|keychain|ppk)|ntuser\.dat.*)$/i;

/** The parts of `child` below `root`, or null when it is not inside (Windows paths are compared without case). */
function partsBelow(root, child) {
  const relative = path.relative(root, child);
  if (relative === '') return [];
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(/[\\/]+/);
}
const startsWithParts = (parts, prefix) => prefix.every((part, index) => (parts[index] || '').toLowerCase() === part.toLowerCase());

const realOrNull = (value) => {
  try { return fs.realpathSync.native(value); } catch { return null; }
};

/**
 * The files of one upload, checked. `values`: paths (one string or a list); a relative one is read from the first of
 * `roots` (the chat's folder, then its artifacts folder). A file may come from those folders, or from anywhere in the
 * user's own folder except the places that hold sign-ins and keys (BLOCKED_UNDER_HOME, SECRET_NAME). Links are followed
 * first, so a link inside an allowed folder cannot reach a blocked one. Returns `[{ absolute, name, size, shown }]`.
 */
function uploadFiles(values, { roots = [], home = os.homedir() } = {}) {
  const list = (Array.isArray(values) ? values : [values]).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
  if (!list.length) throw new Error('upload 需要文件路径');
  if (list.length > MAX_FILES) throw new Error(`一次最多上传 ${MAX_FILES} 个文件`);
  const realRoots = roots.filter((root) => typeof root === 'string' && path.isAbsolute(root)).map(realOrNull).filter(Boolean);
  const realHome = home ? realOrNull(home) : null;
  let total = 0;
  const files = list.map((value) => {
    if (!path.isAbsolute(value) && !realRoots.length) throw new Error(`相对路径没有可以对照的文件夹：${value}；请给绝对路径`);
    const wanted = path.isAbsolute(value) ? value : path.resolve(realRoots[0], value);
    const absolute = realOrNull(wanted);
    if (!absolute) throw new Error(`上传文件不存在：${value}`);
    const root = realRoots.find((candidate) => partsBelow(candidate, absolute) !== null);
    let shown;
    if (root) {
      shown = path.relative(root, absolute).replace(/\\/g, '/') || path.basename(absolute);
    } else {
      const parts = realHome ? partsBelow(realHome, absolute) : null;
      if (!parts) throw new Error(`只能上传你用户文件夹（${realHome || home}）里的文件，或这个对话文件夹里的文件：${absolute}`);
      const blocked = BLOCKED_UNDER_HOME.some((prefix) => startsWithParts(parts, prefix)) && !ALLOWED_UNDER_HOME.some((prefix) => startsWithParts(parts, prefix));
      if (blocked || SECRET_NAME.test(path.basename(absolute))) throw new Error(`这个位置存放登录信息、密钥或程序数据，不能上传到网页：${absolute}`);
      shown = `~/${parts.join('/')}`;
    }
    let stat;
    try { stat = fs.statSync(absolute); } catch { throw new Error(`上传文件不存在：${value}`); }
    if (!stat.isFile()) throw new Error(`只能上传普通文件，不能上传文件夹或设备：${absolute}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES / 1048576} MiB 上限：${absolute}`);
    total += stat.size;
    return { absolute, name: path.basename(absolute), size: stat.size, shown };
  });
  if (total > MAX_TOTAL_BYTES) throw new Error(`这些文件一共 ${(total / 1048576).toFixed(1)} MiB，超过一次上传 ${MAX_TOTAL_BYTES / 1048576} MiB 的上限`);
  return files;
}

/** In a page: the file input to fill when no target was named: one that takes several files when several are given. */
function pageFileInput(arg) {
  const inputs = [];
  const walk = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'INPUT' && element.type === 'file' && !element.disabled) inputs.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  const usable = inputs.filter((element) => !element.webkitdirectory);
  return (arg && arg.many ? usable.find((element) => element.multiple) : null) || usable[0] || null;
}

/**
 * The upload side of one browser host. `hold(tab)` keeps the tab's debugger attached and returns `{ api, release }`;
 * `mouse(tab, value)` and `click(tab, value)` are the host's own pointer commands; `inPage`, `pageLocate`, `pageHelpers`
 * and `interactiveQuery` are the page helpers (browser-page-helpers.cjs).
 */
function createFileChoosers({ hold, mouse, click, inPage, pageLocate, pageHelpers, interactiveQuery, log = () => undefined }) {
  const send = (guard, method, params, sessionId) => guard.api.sendCommand(method, params || {}, sessionId || undefined);
  const takeOver = (guard, sessionId) => Promise.all([
    send(guard, 'Page.enable', {}, sessionId),
    send(guard, 'Page.setInterceptFileChooserDialog', { enabled: true }, sessionId),
    send(guard, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
  ]);

  /** Take over the tab's file choosers (idempotent). Resolves true once they are, false when DevTools is not available. */
  const arm = (tab) => {
    if (tab.chooserGuard) {
      tab.chooserGuard.until = 0;
      return tab.chooserGuard.ready;
    }
    let held;
    try { held = hold(tab); } catch (error) { log(`无法接管文件选择窗口：${error.message}`); return Promise.resolve(false); }
    const guard = { api: held.api, held, sessions: new Map() };
    tab.fileChoosers ||= [];
    tab.chooserSeq ||= 0;
    guard.onMessage = (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget' && params?.targetInfo?.type === 'iframe') {
        guard.sessions.set(params.sessionId, { frameId: params.targetInfo.targetId, parent: sessionId || '', url: params.targetInfo.url || '' });
        takeOver(guard, params.sessionId).catch(() => undefined);
      } else if (method === 'Target.detachedFromTarget') {
        guard.sessions.delete(params?.sessionId);
      } else if (method === 'Target.targetInfoChanged') {
        for (const entry of guard.sessions.values()) if (entry.frameId === params?.targetInfo?.targetId) entry.url = params.targetInfo.url || entry.url;
      } else if (method === 'Page.fileChooserOpened') {
        tab.chooserSeq += 1;
        tab.fileChoosers.push({ seq: tab.chooserSeq, at: Date.now(), mode: params.mode, backendNodeId: params.backendNodeId, frameId: params.frameId, sessionId: sessionId || '', url: sessionId ? guard.sessions.get(sessionId)?.url || '' : tab.url || '' });
        if (tab.fileChoosers.length > 10) tab.fileChoosers.splice(0, tab.fileChoosers.length - 10);
      }
    };
    guard.onDetach = () => { if (tab.chooserGuard === guard) disarm(tab, { detached: true }); };
    try {
      guard.api.on('message', guard.onMessage);
      guard.api.once('detach', guard.onDetach);
    } catch (error) {
      // A debugger that cannot report events cannot take a chooser over; the Agent's commands run as before.
      try { guard.api.removeListener?.('message', guard.onMessage); } catch { /* never added */ }
      held.release();
      log(`无法接管文件选择窗口：${error.message}`);
      return Promise.resolve(false);
    }
    guard.ready = takeOver(guard, '').then(() => true, (error) => { log(`接管文件选择窗口失败：${error.message}`); return false; });
    tab.chooserGuard = guard;
    return guard.ready;
  };

  /** Give the choosers back to the page: the system window opens again for the next one. */
  const disarm = (tab, { detached = false } = {}) => {
    const guard = tab.chooserGuard;
    if (!guard) return;
    tab.chooserGuard = null;
    guard.api.removeListener('message', guard.onMessage);
    guard.api.removeListener('detach', guard.onDetach);
    if (detached) { guard.held.release(); return; }
    const sessions = [...guard.sessions.keys()];
    void (async () => {
      for (const sessionId of sessions) {
        await send(guard, 'Page.setInterceptFileChooserDialog', { enabled: false }, sessionId).catch(() => undefined);
      }
      await send(guard, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
      await send(guard, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
      for (const sessionId of sessions) await send(guard, 'Target.detachFromTarget', { sessionId }).catch(() => undefined);
    })().finally(() => guard.held.release());
  };

  /** Choosers opened after `since` (a chooserSeq), newest last, not yet answered. */
  const openedSince = (tab, since) => (tab.fileChoosers || []).filter((entry) => entry.seq > since && !entry.used && Date.now() - entry.at < CHOOSER_KEEP_MS);
  const waitChooser = async (tab, since, ms) => {
    const until = Date.now() + ms;
    for (;;) {
      const found = openedSince(tab, since);
      if (found.length) return found[found.length - 1];
      if (Date.now() > until || tab.destroyed) return null;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  };
  /** What a click or key press of the Agent opened: the chooser it is waiting on, for the command's answer. */
  const chooserNote = (tab, since) => {
    const found = openedSince(tab, since);
    const last = found[found.length - 1];
    return last ? { mode: last.mode, multiple: last.mode === 'selectMultiple', ...(last.sessionId ? { frame: last.url } : {}) } : undefined;
  };

  /** Where the top-left of a frame's viewport is in the tab's viewport (CSS pixels), through each frame above it. */
  const frameOffset = async (guard, sessionId) => {
    const entry = guard.sessions.get(sessionId);
    if (!entry) return { x: 0, y: 0 };
    const above = entry.parent ? await frameOffset(guard, entry.parent) : { x: 0, y: 0 };
    await send(guard, 'DOM.enable', {}, entry.parent).catch(() => undefined);
    const owner = await send(guard, 'DOM.getFrameOwner', { frameId: entry.frameId }, entry.parent);
    const box = await send(guard, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, entry.parent);
    const quad = box?.model?.content || [0, 0];
    return { x: above.x + quad[0], y: above.y + quad[1] };
  };

  const evaluate = async (guard, sessionId, expression, returnByValue = true) => {
    const answer = await send(guard, 'Runtime.evaluate', { expression, returnByValue, awaitPromise: true }, sessionId);
    if (answer?.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text || '网页脚本出错');
    return answer?.result;
  };

  /** Put the files into a file input (by objectId, in its frame's session); true when the page received them. */
  const fillInput = async (guard, sessionId, objectId, files) => {
    const call = (functionDeclaration) => send(guard, 'Runtime.callFunctionOn', { objectId, functionDeclaration, returnByValue: true }, sessionId).then((answer) => answer?.result?.value);
    const element = (await call('function(){ return { tag: this.tagName, type: this.type || "", disabled: !!this.disabled, multiple: !!this.multiple, folder: !!this.webkitdirectory, accept: this.accept || "" }; }')) || {};
    if (element.tag !== 'INPUT' || element.type !== 'file') return { notInput: true, element };
    if (element.disabled) throw new Error('这个文件输入框已禁用');
    if (element.folder) throw new Error('这个上传框要的是文件夹（webkitdirectory），不是文件；换用网页上传文件的按钮');
    if (files.length > 1 && !element.multiple) throw new Error(`这个上传框一次只收一个文件，这次给了 ${files.length} 个；请逐个上传`);
    await send(guard, 'DOM.enable', {}, sessionId).catch(() => undefined);
    // DOM.setFileInputFiles fires input and change itself, as a person's choice does. Whether the page saw them is noted
    // as the events pass the window (capture), with the most files the input held then: pages often take the file and
    // empty the input right away (some in a capturing handler of their own that runs first), so that the same file can
    // be chosen again, and then the input looks empty although the page has the file.
    await call('function(){ const input = this; const note = (event) => { if (event.target !== input) return; const count = input.files ? input.files.length : 0; if (input.__myharnessUpload && input.__myharnessUpload.count >= count) return; input.__myharnessUpload = { fired: true, count, name: input.files && input.files[0] ? input.files[0].name : "" }; }; input.__myharnessUpload = null; input.__myharnessUploadStop = () => { window.removeEventListener("change", note, true); window.removeEventListener("input", note, true); }; window.addEventListener("change", note, true); window.addEventListener("input", note, true); }');
    await send(guard, 'DOM.setFileInputFiles', { files: files.map((file) => file.absolute), objectId }, sessionId);
    // A change that comes a moment later still counts; only when none came are the events sent here.
    for (let waited = 0; waited < 300; waited += 50) {
      if (await call('function(){ return !!this.__myharnessUpload; }')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const seen = (await call('function(){ const held = { count: this.files ? this.files.length : 0, name: this.files && this.files[0] ? this.files[0].name : "" }; let seen = this.__myharnessUpload; if (!seen && held.count) { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); seen = this.__myharnessUpload || held; } if (this.__myharnessUploadStop) this.__myharnessUploadStop(); delete this.__myharnessUpload; delete this.__myharnessUploadStop; return seen || held; }')) || {};
    // The page heard of the files (its input or change event came) even when it emptied the input before anyone else
    // could look: a page that takes the file and clears the input at once (an image search) is a received upload.
    if (!seen.count && !seen.fired) throw new Error(`文件输入框没有接收到文件${element.accept ? `（它只收 ${element.accept}）` : ''}`);
    return { count: seen.count || files.length, accept: element.accept };
  };

  /** Answer a chooser the page opened with the files. */
  const fillChooser = async (guard, chooser, files) => {
    if (files.length > 1 && chooser.mode !== 'selectMultiple') throw new Error(`网页打开的选择窗口一次只收一个文件，这次给了 ${files.length} 个；请逐个上传`);
    chooser.used = true;
    await send(guard, 'DOM.enable', {}, chooser.sessionId).catch(() => undefined);
    await send(guard, 'DOM.setFileInputFiles', { files: files.map((file) => file.absolute), backendNodeId: chooser.backendNodeId }, chooser.sessionId);
    return { count: files.length };
  };

  /** A file input anywhere in the page (frames too); `{ sessionId, objectId, url }` or null. */
  const findInput = async (tab, guard, many) => {
    const expression = `(${pageFileInput})(${JSON.stringify({ many })})`;
    for (const sessionId of ['', ...guard.sessions.keys()]) {
      const found = await evaluate(guard, sessionId, expression, false).catch(() => null);
      if (found?.objectId) return { sessionId, objectId: found.objectId, url: sessionId ? guard.sessions.get(sessionId)?.url || '' : tab.url || '' };
    }
    return null;
  };

  /** Press a control found by its visible words inside a cross-origin frame. Null when no frame shows it. */
  const clickInFrames = async (tab, guard, label) => {
    for (const [sessionId, entry] of guard.sessions) {
      const found = await evaluate(guard, sessionId, inPage(pageLocate, { label }), true).then((result) => result?.value, () => null);
      if (!found?.ok || !found.inView) continue;
      const offset = await frameOffset(guard, sessionId).catch(() => null);
      if (!offset) continue;
      const x = Math.round(offset.x + found.x);
      const y = Math.round(offset.y + found.y);
      await mouse(tab, { kind: 'click', x, y });
      return { ok: true, tag: found.tag, text: found.text || '', x, y, frame: entry.url };
    }
    return null;
  };

  /**
   * One upload into the tab. `target`: an <input type="file"> (`selector`/`index`), or a control that opens the page's
   * chooser (`label`, `selector`, `index`, or the point `x`/`y` from a screenshot; frames are searched for a label). With
   * no target: the chooser the Agent's last click opened, else the page's own file input (frames included).
   */
  const upload = async (tab, files, target = {}) => {
    if (!(await arm(tab))) throw new Error('无法接管网页的文件选择窗口（网页调试接口不可用），这次不能上传');
    const guard = tab.chooserGuard;
    const result = (how, extra) => ({ ok: true, how, count: files.length, name: files[0].name, size: files.reduce((sum, file) => sum + file.size, 0), path: files[0].shown, files: files.map((file) => ({ name: file.name, size: file.size, path: file.shown })), ...extra });
    const hasPoint = Number.isFinite(target.x) && Number.isFinite(target.y);
    const hasTarget = hasPoint || Number.isInteger(target.index) || (typeof target.selector === 'string' && !!target.selector) || (typeof target.label === 'string' && !!target.label.trim());

    if (!hasTarget) {
      const pending = openedSince(tab, 0);
      const chooser = pending[pending.length - 1];
      if (chooser) return result('chooser', { ...(await fillChooser(guard, chooser, files)), ...(chooser.sessionId ? { frame: chooser.url } : {}) });
      const input = await findInput(tab, guard, files.length > 1);
      if (!input) throw new Error('页面上没有找到文件输入框，也没有等待中的选择窗口；请用 label（按钮上的字，例如「上传」「附加」）、selector、index 或截图坐标 x/y 指向上传按钮');
      return result('input', { ...(await fillInput(guard, input.sessionId, input.objectId, files)), ...(input.sessionId ? { frame: input.url } : {}) });
    }

    // A file input named by selector or index takes the files directly.
    if (!hasPoint && !target.label && (target.selector || Number.isInteger(target.index))) {
      const expression = Number.isInteger(target.index)
        ? `(${pageHelpers})(${JSON.stringify(interactiveQuery)}).all(${JSON.stringify(interactiveQuery)})[${target.index}]`
        : `document.querySelector(${JSON.stringify(target.selector)})`;
      const found = await evaluate(guard, '', expression, false).catch(() => null);
      if (!found?.objectId) {
        // Not in the page itself: a frame may hold it.
        if (target.selector) {
          for (const sessionId of guard.sessions.keys()) {
            const inFrame = await evaluate(guard, sessionId, expression, false).catch(() => null);
            if (!inFrame?.objectId) continue;
            const filled = await fillInput(guard, sessionId, inFrame.objectId, files);
            if (!filled.notInput) return result('input', { ...filled, frame: guard.sessions.get(sessionId)?.url || '' });
            break;
          }
        }
        throw new Error(Number.isInteger(target.index) ? `没有索引为 ${target.index} 的可交互元素` : `没有匹配 ${target.selector} 的元素`);
      }
      const filled = await fillInput(guard, '', found.objectId, files);
      await send(guard, 'Runtime.releaseObject', { objectId: found.objectId }).catch(() => undefined);
      if (!filled.notInput) return result('input', filled);
      // Not a file input: a button, pressed below like a label.
    }

    // A control that opens the chooser: pressed with the real mouse, its chooser answered.
    const since = tab.chooserSeq || 0;
    let pressed;
    if (hasPoint) {
      const answer = await mouse(tab, { kind: 'click', x: Number(target.x), y: Number(target.y) });
      pressed = { tag: answer.target?.tag, text: answer.target?.text || '', x: Number(target.x), y: Number(target.y) };
    } else {
      try {
        pressed = await click(tab, { selector: target.label ? undefined : target.selector, index: target.label ? undefined : target.index, label: target.label });
      } catch (error) {
        pressed = target.label ? await clickInFrames(tab, guard, target.label.trim()) : null;
        if (!pressed) throw error;
      }
    }
    const chooser = await waitChooser(tab, since, CHOOSER_WAIT_MS);
    if (!chooser) {
      const what = `${pressed?.tag || '元素'}${pressed?.text ? ` "${String(pressed.text).slice(0, 60)}"` : ''}`;
      throw new Error(`点了 ${what}，但网页没有打开选择文件的窗口；如果它打开的是菜单，再用 upload 的 label 指向菜单里「从此设备上传」「浏览此计算机」这类选项`);
    }
    return result('chooser', { ...(await fillChooser(guard, chooser, files)), pressed: { tag: pressed?.tag, text: pressed?.text || '', x: pressed?.x, y: pressed?.y }, ...(chooser.sessionId ? { frame: chooser.url } : {}) });
  };

  return { arm, disarm, upload, chooserNote, seq: (tab) => tab.chooserSeq || 0 };
}

module.exports = { uploadFiles, createFileChoosers, pageFileInput, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, CHOOSER_KEEP_MS };
