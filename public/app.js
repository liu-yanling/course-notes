(function () {
  'use strict';

  var state = window.__courseState = {
    status: null,
    config: null,
    llm: null,
    history: { subjects: [], videos: [] },
    polls: [],
    task: null,
    summary: '',
    done: null,
    connected: false,
    settingsOpen: false,
    onboardingStep: 1,
    pendingDataDir: '',
    autostart: null,
    view: 'home',
    summaryTab: 'summary',
    tab: 'videos',
    query: '',
    lastError: '',
    dirty: false
  };

  var els = {};
  var es = null;
  var summaryTimer = null;
  var countdownTimer = null;

  function $(id) { return document.getElementById(id); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function formatClock(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function formatDate(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  function toast(message, type) {
    var el = els.toast;
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show' + (type ? ' ' + type : '');
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      el.className = 'toast';
      setTimeout(function () { el.hidden = true; }, 200);
    }, 2600);
  }
  async function fetchJson(url, options) {
    var response = await fetch(url, options || {});
    var data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok || (data && data.ok === false)) {
      var message = (data && data.message) || ('HTTP ' + response.status);
      var error = new Error(message);
      error.code = data && data.code;
      throw error;
    }
    return data;
  }
  function postJson(url, body) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function cacheEls() {
    var ids = [
      'statusPill', 'statusText', 'masterSwitch', 'btnPollNow', 'btnSettings', 'btnSettingsNav', 'offlineBanner',
      'pollBadge', 'frontApp', 'currentTitle', 'currentUrl', 'currentSource', 'currentTime',
      'nextPoll', 'ringProgress', 'intervalLabel', 'lastPollTime', 'stableLabel',
      'intervalRange', 'intervalNumber', 'intervalPresets', 'stablePolls',
      'btnClearPolls', 'pollList',
      'pageTitle', 'pageSubtitle', 'viewHome', 'viewLibrary', 'heroForm', 'heroUrl',
      'sidebarRecent', 'sidebarDot', 'sidebarStatus',
      'taskBadge', 'stepper', 'taskProgress', 'summaryEmpty', 'summaryContent',
      'taskTitle', 'taskStatus', 'summaryKeywords', 'summaryMeta', 'summaryMarkdown',
      'summaryCover', 'summaryCoverFallback', 'summaryTabs', 'btnCopySummary',
      'btnOpenDoc', 'btnDownloadDoc', 'btnOpenDir', 'manualForm', 'manualUrl',
      'historyTabs', 'historySearch', 'historyList', 'libraryStats',
      'settingsBackdrop', 'settingsDrawer', 'settingsClose', 'settingsCancel',
      'setInterval', 'setStable', 'setBackend', 'setAutoStart',
      'llmProvider', 'llmModel', 'llmBaseUrl', 'llmApiKey',
      'llmKeyStatus', 'btnTestLlm', 'btnShortcut', 'shortcutStatus', 'btnShutdown',
      'outputDir', 'btnSaveSettings', 'toast', 'footerPort', 'setDataDir', 'notifyOnComplete',
      'updateCurrent', 'updateStatus', 'btnCheckUpdate', 'updateDownload', 'updateUrl',
      'autostart', 'autostartStatus',
      'onboarding', 'onboardStep1', 'onboardStep2', 'onboardStep3', 'onboardDataDir',
      'onboardNext1', 'onboardProvider', 'onboardKey', 'onboardSaveKey', 'onboardKeyStatus',
      'onboardSkipLlm', 'onboardNext2', 'onboardOpenPrivacy', 'onboardFinish', 'onboardSkipAll'
    ];
    for (var i = 0; i < ids.length; i++) els[ids[i]] = $(ids[i]);
  }

  function bindEvents() {
    els.masterSwitch.addEventListener('change', function () {
      setEnabled(els.masterSwitch.checked);
    });
    els.btnPollNow.addEventListener('click', pollNow);
    els.btnSettings.addEventListener('click', openSettings);
    els.btnSettingsNav.addEventListener('click', openSettings);
    qsa('.nav-item[data-view]').forEach(function (button) {
      button.addEventListener('click', function () { switchView(button.getAttribute('data-view')); });
    });
    els.heroForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = String(els.heroUrl.value || '').trim();
      if (value) manualScan(value);
    });
    els.summaryTabs.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-tab]');
      if (!button) return;
      state.summaryTab = button.getAttribute('data-tab');
      qsa('#summaryTabs button').forEach(function (item) {
        item.classList.toggle('active', item === button);
      });
      renderSummary();
    });
    els.btnCopySummary.addEventListener('click', function () {
      if (!state.summary) return;
      navigator.clipboard.writeText(state.summary).then(function () {
        toast('总结已复制', 'success');
      }).catch(function () { toast('复制失败', 'error'); });
    });
    els.settingsClose.addEventListener('click', closeSettings);
    els.settingsCancel.addEventListener('click', closeSettings);
    els.settingsBackdrop.addEventListener('click', closeSettings);
    els.btnSaveSettings.addEventListener('click', saveSettings);
    els.btnTestLlm.addEventListener('click', testLlm);
    els.btnCheckUpdate.addEventListener('click', checkUpdate);
    els.autostart.addEventListener('change', async function () {
      var enabled = els.autostart.checked;
      els.autostart.disabled = true;
      try {
        var data = await postJson('/api/autostart', { enabled: enabled });
        state.autostart = data.autostart;
        renderAutostart();
        toast(enabled ? '已开启开机自启' : '已关闭开机自启', 'success');
      } catch (error) {
        els.autostart.checked = !enabled;
        toast(error.message, 'error');
      } finally {
        els.autostart.disabled = false;
      }
    });
    els.updateDownload.addEventListener('click', function () {
      if (!state.update || !state.update.downloadUrl) return;
      postJson('/api/open-url', { url: state.update.downloadUrl }).catch(function (error) { toast(error.message, 'error'); });
    });
    els.btnShortcut.addEventListener('click', createShortcut);
    els.btnShutdown.addEventListener('click', shutdownServer);

    els.intervalRange.addEventListener('input', function () {
      var value = clamp(els.intervalRange.value, 3, 120);
      els.intervalNumber.value = value;
      updateIntervalLabel(value);
    });
    els.intervalRange.addEventListener('change', function () {
      saveInterval(clamp(els.intervalRange.value, 3, 120));
    });
    els.intervalNumber.addEventListener('change', function () {
      var value = clamp(els.intervalNumber.value, 3, 120);
      els.intervalRange.value = value;
      updateIntervalLabel(value);
      saveInterval(value);
    });
    els.intervalPresets.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-sec]');
      if (!button) return;
      var value = clamp(button.getAttribute('data-sec'), 3, 120);
      els.intervalRange.value = value;
      els.intervalNumber.value = value;
      updateIntervalLabel(value);
      saveInterval(value);
    });
    els.stablePolls.addEventListener('change', function () {
      var value = clamp(els.stablePolls.value, 1, 5);
      els.stablePolls.value = value;
      postJson('/api/config', { stablePolls: value }).then(function (data) {
        state.config = data.config;
        state.status = data.status;
        renderAll();
        toast('连续确认次数已更新为 ' + value + ' 次', 'success');
      }).catch(function (error) { toast(error.message, 'error'); });
    });
    qsa('[data-stable]').forEach(function (button) {
      button.addEventListener('click', function () {
        var delta = Number(button.getAttribute('data-stable'));
        var value = clamp(Number(els.stablePolls.value) + delta, 1, 5);
        els.stablePolls.value = value;
        els.stablePolls.dispatchEvent(new Event('change'));
      });
    });

    els.btnClearPolls.addEventListener('click', function () {
      state.polls = [];
      renderPolls();
    });
    els.btnOpenDoc.addEventListener('click', function () {
      var path = state.done && state.done.noteDocx;
      if (path) openPath(path);
    });
    els.btnDownloadDoc.addEventListener('click', function () {
      var path = state.done && state.done.noteDocx;
      if (path) downloadPath(path);
    });
    els.btnOpenDir.addEventListener('click', function () {
      openPath(state.config && state.config.outputDir, true);
    });
    els.manualForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = String(els.manualUrl.value || '').trim();
      if (!value) return;
      manualScan(value);
    });
    els.historyTabs.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-tab]');
      if (!button) return;
      state.tab = button.getAttribute('data-tab');
      qsa('#historyTabs button').forEach(function (item) {
        item.classList.toggle('active', item === button);
      });
      renderHistory();
    });
    els.historySearch.addEventListener('input', function () {
      state.query = els.historySearch.value.trim().toLowerCase();
      renderHistory();
    });

    els.llmProvider.addEventListener('change', function () {
      var provider = els.llmProvider.value;
      if (provider === 'ollama' && (!els.llmModel.value || els.llmModel.value === 'deepseek-chat')) {
        els.llmModel.value = 'deepseek-r1:7b';
      }
      if (provider === 'deepseek' && (!els.llmModel.value || els.llmModel.value === 'deepseek-r1:7b')) {
        els.llmModel.value = 'deepseek-chat';
      }
      if (provider === 'local') els.llmModel.value = 'local';
    });
    ['setInterval', 'setStable', 'setBackend', 'setAutoStart', 'llmProvider', 'llmModel', 'llmBaseUrl', 'llmApiKey', 'setDataDir', 'notifyOnComplete'].forEach(function (id) {
      if (els[id]) els[id].addEventListener('input', function () { state.dirty = true; });
    });
  }

  function updateIntervalLabel(seconds) {
    els.intervalLabel.textContent = seconds + ' 秒';
    qsa('#intervalPresets button').forEach(function (button) {
      button.classList.toggle('active', Number(button.getAttribute('data-sec')) === Number(seconds));
    });
  }

  function saveInterval(seconds) {
    postJson('/api/config', { pollIntervalMs: seconds * 1000 }).then(function (data) {
      state.config = data.config;
      state.status = data.status;
      renderAll();
      toast('轮询间隔已改为 ' + seconds + ' 秒', 'success');
    }).catch(function (error) {
      toast(error.message, 'error');
    });
  }

  function setEnabled(enabled) {
    els.masterSwitch.disabled = true;
    postJson('/api/control', { action: enabled ? 'start' : 'stop' }).then(function (data) {
      state.status = data.status;
      renderStatus();
      toast(enabled ? '已启动轮询' : '已暂停轮询', enabled ? 'success' : '');
    }).catch(function (error) {
      toast(error.message, 'error');
      if (state.status) els.masterSwitch.checked = Boolean(state.status.enabled);
    }).finally(function () {
      els.masterSwitch.disabled = false;
    });
  }

  function pollNow() {
    postJson('/api/control', { action: 'pollNow' }).then(function () {
      toast('已触发一次检测');
    }).catch(function (error) {
      toast(error.message, 'error');
    });
  }

  function manualScan(value) {
    switchView('home');
    var isUrl = /^https?:\/\//i.test(value);
    state.summary = '';
    state.done = null;
    state.task = { stage: 'classify', progress: 4, title: value, message: '准备手动总结…' };
    renderTask();
    renderSummary();
    postJson('/api/control', {
      action: 'scan',
      url: isUrl ? value : '',
      title: isUrl ? '' : value
    }).then(function () {
      els.manualUrl.value = '';
      if (els.heroUrl) els.heroUrl.value = '';
      toast('已开始总结，请在右侧查看实时输出', 'success');
    }).catch(function (error) {
      toast(error.message, 'error');
    });
  }

  function openPath(path, reveal) {
    if (!path) return;
    postJson('/api/open', { path: path, reveal: Boolean(reveal) }).then(function () {
      toast('已打开');
    }).catch(function (error) { toast(error.message, 'error'); });
  }

  function downloadPath(path) {
    if (!path) return;
    window.location.href = '/api/doc?path=' + encodeURIComponent(path);
  }

  async function saveKey(key) {
    const value = String(key ?? '').trim();
    if (!value) return { ok: true, source: 'none' };
    try {
      const data = await postJson('/api/llm/key', { key: value });
      if (data.llm) state.llm = data.llm;
      return { ok: true, source: 'keychain' };
    } catch (error) {
      try {
        const data = await postJson('/api/config', { llm: { apiKey: value } });
        state.config = data.config;
        state.llm = { keySet: true, keySource: 'config' };
        return { ok: true, source: 'config', warning: error.message };
      } catch (fallbackError) {
        return { ok: false, error: fallbackError.message };
      }
    }
  }

  function showOnboarding() {
    if (!els.onboarding) return;
    state.pendingDataDir = (state.config && state.config.outputDir) || '';
    els.onboardDataDir.value = state.pendingDataDir;
    els.onboardProvider.value = (state.config && state.config.llm && state.config.llm.provider) || 'deepseek';
    els.onboarding.hidden = false;
    goOnboardStep(1);
  }

  function goOnboardStep(step) {
    state.onboardingStep = step;
    [els.onboardStep1, els.onboardStep2, els.onboardStep3].forEach(function (section, index) {
      section.hidden = index + 1 !== step;
    });
    qsa('[data-onboard-dot]').forEach(function (dot) {
      dot.classList.toggle('active', Number(dot.getAttribute('data-onboard-dot')) === step);
    });
  }

  async function finishOnboarding(skip) {
    var provider = skip ? 'local' : els.onboardProvider.value;
    var model = provider === 'ollama' ? 'deepseek-r1:7b' : provider === 'local' ? 'local' : 'deepseek-chat';
    var payload = {
      onboardingDone: true,
      outputDir: state.pendingDataDir || (state.config && state.config.outputDir),
      llm: { provider: provider, model: model }
    };
    try {
      var data = await postJson('/api/config', payload);
      state.config = data.config;
      state.status = data.status;
      els.onboarding.hidden = true;
      renderAll();
      toast('设置完成，开始使用 course notes', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function bindOnboarding() {
    if (!els.onboarding) return;
    els.onboardNext1.addEventListener('click', function () {
      var value = String(els.onboardDataDir.value || '').trim();
      if (!value) { toast('请填写数据目录', 'error'); return; }
      state.pendingDataDir = value;
      goOnboardStep(2);
    });
    els.onboardProvider.addEventListener('change', function () {
      var provider = els.onboardProvider.value;
      els.onboardKey.disabled = provider === 'local';
      if (provider === 'local') els.onboardKey.value = '';
    });
    els.onboardSaveKey.addEventListener('click', async function () {
      var key = String(els.onboardKey.value || '').trim();
      if (!key) { els.onboardKeyStatus.textContent = '先输入 Key，或选择本地提取'; return; }
      els.onboardSaveKey.disabled = true;
      els.onboardKeyStatus.textContent = '保存中…';
      var saved = await saveKey(key);
      if (!saved.ok) {
        els.onboardKeyStatus.textContent = saved.error;
        els.onboardSaveKey.disabled = false;
        return;
      }
      els.onboardKey.value = '';
      els.onboardKeyStatus.textContent = saved.source === 'keychain' ? '已保存到 Keychain，正在测试…' : '已临时保存到配置文件，正在测试…';
      try {
        var result = await postJson('/api/llm/test', {});
        els.onboardKeyStatus.textContent = result.result && result.result.ok ? '连接正常，可以继续' : (result.result && result.result.message) || '连接失败';
      } catch (error) {
        els.onboardKeyStatus.textContent = error.message;
      }
      els.onboardSaveKey.disabled = false;
    });
    els.onboardSkipLlm.addEventListener('click', function () {
      els.onboardProvider.value = 'local';
      goOnboardStep(3);
    });
    els.onboardNext2.addEventListener('click', async function () {
      var key = String(els.onboardKey.value || '').trim();
      if (key) {
        var saved = await saveKey(key);
        if (!saved.ok) { els.onboardKeyStatus.textContent = saved.error; return; }
      }
      goOnboardStep(3);
    });
    els.onboardOpenPrivacy.addEventListener('click', function () {
      postJson('/api/open-url', { url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation' })
        .catch(function (error) { toast(error.message, 'error'); });
    });
    els.onboardFinish.addEventListener('click', function () { finishOnboarding(false); });
    els.onboardSkipAll.addEventListener('click', function () { finishOnboarding(true); });
  }

  function openSettings() {
    state.dirty = false;
    state.settingsOpen = true;
    renderSettings();
    els.settingsBackdrop.hidden = false;
    els.settingsDrawer.classList.add('open');
    els.settingsDrawer.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    state.settingsOpen = false;
    els.settingsDrawer.classList.remove('open');
    els.settingsDrawer.setAttribute('aria-hidden', 'true');
    els.settingsBackdrop.hidden = true;
  }

  function renderSettings() {
    var config = state.config || {};
    var llm = config.llm || {};
    if (!state.dirty) {
      els.setInterval.value = Math.round((config.pollIntervalMs || 15000) / 1000);
      els.setStable.value = config.stablePolls || 2;
      els.setBackend.value = config.backend || 'auto';
      els.setAutoStart.checked = config.enabled !== false;
      els.llmProvider.value = llm.provider || 'deepseek';
      els.llmModel.value = llm.model || 'deepseek-chat';
      els.llmBaseUrl.value = llm.baseUrl || 'https://api.deepseek.com/v1';
      els.llmApiKey.value = '';
      els.setDataDir.value = config.outputDir || '';
      els.notifyOnComplete.checked = config.notifyOnComplete !== false;
      els.updateUrl.value = config.updateUrl || '';
      els.updateCurrent.textContent = 'v' + ((state.status && state.status.version) || '1.0.0');
      renderAutostart();
    }
    els.outputDir.textContent = config.outputDir || '—';
    var key = state.llm || {};
    els.llmKeyStatus.textContent = key.keySet
      ? 'Key 可用（' + (key.keySource === 'keychain' ? 'Keychain' : key.keySource === 'env' ? '环境变量' : key.keySource === 'config' ? '配置文件' : '自定义') + '）'
      : '未检测到可用 Key';
    var desktop = (state.status && state.status.desktop) || {};
    els.shortcutStatus.textContent = desktop.installed
      ? '桌面快捷方式已创建：' + desktop.desktopPath
      : desktop.built
        ? '已构建 app，但尚未复制到桌面。点击上方按钮创建。'
        : '尚未构建桌面快捷方式。';
  }

  function collectSettings() {
    var provider = els.llmProvider.value;
    var patch = {
      pollIntervalMs: clamp(els.setInterval.value, 3, 120) * 1000,
      stablePolls: clamp(els.setStable.value, 1, 5),
      backend: els.setBackend.value,
      enabled: els.setAutoStart.checked,
      outputDir: String(els.setDataDir.value || '').trim() || undefined,
      notifyOnComplete: els.notifyOnComplete.checked,
      updateUrl: String(els.updateUrl.value || '').trim(),
      llm: {
        provider: provider,
        model: String(els.llmModel.value || '').trim() || (provider === 'ollama' ? 'deepseek-r1:7b' : provider === 'local' ? 'local' : 'deepseek-chat'),
        baseUrl: String(els.llmBaseUrl.value || '').trim()
      }
    };
    return patch;
  }

  async function saveSettings() {
    els.btnSaveSettings.disabled = true;
    try {
      var key = String(els.llmApiKey.value || '').trim();
      if (key) {
        var saved = await saveKey(key);
        if (!saved.ok) throw new Error(saved.error || 'Key 保存失败');
        els.llmApiKey.value = '';
        els.llmKeyStatus.textContent = saved.source === 'keychain' ? 'Key 已保存到 Keychain' : 'Key 已临时保存到配置文件';
      }
      var data = await postJson('/api/config', collectSettings());
      state.config = data.config;
      state.status = data.status;
      state.dirty = false;
      closeSettings();
      renderAll();
      toast('设置已保存', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      els.btnSaveSettings.disabled = false;
    }
  }

  function renderAutostart() {
    if (!els.autostart) return;
    var info = state.autostart || {};
    els.autostart.checked = Boolean(info.enabled);
    els.autostart.disabled = !info.supported;
    els.autostartStatus.textContent = !info.supported
      ? '当前构建未包含菜单栏组件；安装正式 app 后可开启。'
      : info.enabled
        ? '登录后自动启动菜单栏助手，不打开浏览器。'
        : '关闭时不会随登录启动；可随时在菜单栏打开。';
  }

  async function checkUpdate() {
    els.btnCheckUpdate.disabled = true;
    els.updateStatus.textContent = '检查中…';
    els.updateDownload.hidden = true;
    try {
      var url = String(els.updateUrl.value || '').trim();
      if (url !== ((state.config && state.config.updateUrl) || '')) {
        var saved = await postJson('/api/config', { updateUrl: url });
        state.config = saved.config;
        state.status = saved.status;
      }
      if (!url) {
        els.updateStatus.textContent = '尚未配置更新地址；内测版可留空。';
        return;
      }
      var data = await fetchJson('/api/update');
      state.update = data;
      els.updateCurrent.textContent = 'v' + (data.currentVersion || '1.0.0');
      if (!data.ok) {
        els.updateStatus.textContent = data.message || '检查更新失败';
        return;
      }
      if (data.updateAvailable) {
        els.updateStatus.textContent = '发现新版本 v' + data.latestVersion + (data.notes ? '：' + data.notes : '');
        els.updateDownload.hidden = !data.downloadUrl;
        toast('发现 course notes 新版本 v' + data.latestVersion, 'success');
      } else {
        els.updateStatus.textContent = '已是最新版本 v' + data.currentVersion;
      }
    } catch (error) {
      els.updateStatus.textContent = error.message;
    } finally {
      els.btnCheckUpdate.disabled = false;
    }
  }

  async function testLlm() {
    els.btnTestLlm.disabled = true;
    els.llmKeyStatus.textContent = '测试中…';
    try {
      var data = await postJson('/api/llm/test', {});
      var result = data.result || {};
      els.llmKeyStatus.textContent = result.ok
        ? (result.message || '连接正常') + (result.latencyMs != null ? '（' + result.latencyMs + 'ms）' : '')
        : (result.message || '连接失败');
      toast(result.ok ? 'LLM 连接正常' : (result.message || '连接失败'), result.ok ? 'success' : 'error');
    } catch (error) {
      els.llmKeyStatus.textContent = error.message;
      toast(error.message, 'error');
    } finally {
      els.btnTestLlm.disabled = false;
    }
  }

  async function createShortcut() {
    els.btnShortcut.disabled = true;
    try {
      var data = await postJson('/api/shortcut', {});
      els.shortcutStatus.textContent = '桌面快捷方式：' + (data.target || '已创建');
      toast('桌面快捷方式已创建', 'success');
      if (state.status) state.status.desktop = data.status || state.status.desktop;
      renderSettings();
    } catch (error) {
      els.shortcutStatus.textContent = '创建失败：' + error.message + '。可双击工作区「创建桌面快捷方式.command」重试。';
      toast(error.message, 'error');
    } finally {
      els.btnShortcut.disabled = false;
    }
  }

  async function shutdownServer() {
    if (!window.confirm('停止 course notes 服务？页面将断开，再次使用请双击桌面快捷方式。')) return;
    try {
      await postJson('/api/control', { action: 'shutdown' });
    } catch (error) {
      /* server may close before responding */
    }
    state.connected = false;
    renderStatus();
    toast('服务已停止', '');
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onopen = function () {
      state.connected = true;
      els.offlineBanner.hidden = true;
      renderStatus();
    };
    es.onerror = function () {
      state.connected = false;
      els.offlineBanner.hidden = false;
      renderStatus();
    };
    es.onmessage = function (event) {
      try {
        handleEvent(JSON.parse(event.data));
      } catch (error) {
        /* ignore malformed event */
      }
    };
  }

  function handleEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'hello') {
      if (event.status) state.status = Object.assign({}, state.status || {}, event.status);
      if (event.config) state.config = event.config;
      if (Array.isArray(event.polls) && event.polls.length) state.polls = event.polls;
      state.connected = true;
      els.offlineBanner.hidden = true;
      renderAll();
      return;
    }
    if (event.type === 'status') {
      state.status = event;
      renderStatus();
      return;
    }
    if (event.type === 'config') {
      state.config = event.config;
      renderSettings();
      renderStatus();
      return;
    }
    if (event.type === 'poll') {
      state.polls.unshift(event);
      if (state.polls.length > 60) state.polls.length = 60;
      renderPolls();
      renderStatus();
      return;
    }
    if (event.type === 'task') {
      state.task = event;
      if (event.stage === 'done' || event.stage === 'error') {
        // Keep the final task state visible.
      }
      renderTask();
      return;
    }
    if (event.type === 'summary:delta') {
      state.summary += event.text || '';
      scheduleSummaryRender();
      return;
    }
    if (event.type === 'summary:done') {
      state.done = event;
      state.task = {
        taskId: event.taskId,
        stage: 'done',
        progress: 100,
        title: event.title,
        message: '知识总结完成',
        at: Date.now()
      };
      if (event.markdown) state.summary = event.markdown;
      renderTask();
      renderSummary();
      fetchHistory();
      toast('知识总结完成：' + (event.subject || '') + ' · ' + (event.title || ''), 'success');
      return;
    }
    if (event.type === 'error') {
      state.lastError = event.message || '';
      toast(event.message || '发生错误', 'error');
      return;
    }
    if (event.type === 'log' && event.level === 'error') {
      state.lastError = event.message || '';
      return;
    }
    if (event.type === 'shutdown') {
      state.connected = false;
      els.offlineBanner.hidden = false;
      renderStatus();
    }
  }

  function switchView(view) {
    state.view = view === 'library' ? 'library' : 'home';
    qsa('.nav-item[data-view]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-view') === state.view);
    });
    els.viewHome.hidden = state.view !== 'home';
    els.viewLibrary.hidden = state.view !== 'library';
    els.pageTitle.textContent = state.view === 'library' ? '学习档案' : '主页';
    els.pageSubtitle.textContent = state.view === 'library'
      ? '所有视频笔记与学科学习手册'
      : '检测当前 B 站课程，自动生成学科知识地图';
    if (state.view === 'library') {
      renderHistory();
      renderLibraryStats();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderLibraryStats() {
    if (!els.libraryStats) return;
    var videos = (state.history && state.history.videos) || [];
    var subjects = (state.history && state.history.subjects) || [];
    els.libraryStats.innerHTML =
      '<span><strong>' + videos.length + '</strong> 个视频</span>' +
      '<span><strong>' + subjects.length + '</strong> 个学科</span>' +
      '<span><strong>' + videos.filter(function (video) { return video.noteDocx; }).length + '</strong> 份 Word</span>';
  }

  function renderSidebarRecent() {
    if (!els.sidebarRecent) return;
    var videos = ((state.history && state.history.videos) || []).slice(0, 5);
    if (!videos.length) {
      els.sidebarRecent.innerHTML = '<div class="muted tiny" style="padding:0 12px">还没有记录</div>';
      return;
    }
    els.sidebarRecent.innerHTML = videos.map(function (video) {
      return '<button class="recent-item" data-key="' + esc(video.key || video.bvid || '') + '">' +
        esc(video.title || '未命名视频') +
        '<span class="recent-sub">' + esc((video.date || '') + ' · ' + (video.subject || '')) + '</span>' +
      '</button>';
    }).join('');
    els.sidebarRecent.querySelectorAll('[data-key]').forEach(function (button) {
      button.addEventListener('click', function () {
        switchView('home');
        loadVideo(button.getAttribute('data-key'));
      });
    });
  }

  function renderAll() {
    renderStatus();
    renderPolls();
    renderTask();
    renderSummary();
    renderHistory();
    renderSidebarRecent();
    renderLibraryStats();
    renderSettings();
  }

  function renderStatus() {
    var status = state.status || {};
    if (status.task && (!state.task || state.task.taskId !== status.task.taskId || state.task.stage !== status.task.stage)) {
      state.task = status.task;
      renderTask();
    }
    var connected = state.connected;
    var enabled = Boolean(status.enabled);
    var busy = Boolean(status.busy);
    var working = busy || (state.task && ['classify', 'fetch', 'summarize', 'docs'].indexOf(state.task.stage) >= 0);
    els.statusPill.className = 'status-pill ' + (!connected ? 'offline' : working ? 'working' : enabled ? 'running' : 'paused');
    els.statusText.textContent = !connected ? '离线' : working ? '总结中' : enabled ? '运行中' : '已暂停';
    els.masterSwitch.checked = enabled;
    els.pollBadge.textContent = !connected ? '离线' : enabled ? (working ? '总结中' : '运行中') : '已暂停';
    els.pollBadge.className = 'mini-badge ' + (!connected ? 'error' : enabled ? 'active' : '');

    els.frontApp.textContent = status.frontApp || '—';
    var current = status.current || {};
    els.currentTitle.textContent = current.title || '还没有检测到 B 站视频';
    if (current.url) {
      els.currentUrl.hidden = false;
      els.currentUrl.href = current.url;
      els.currentUrl.textContent = current.url;
    } else {
      els.currentUrl.hidden = true;
      els.currentUrl.removeAttribute('href');
    }
    els.currentSource.textContent = '来源：' + (current.source || '—');
    els.currentTime.textContent = '最后观察：' + (current.at ? formatClock(current.at) : '—');

    var seconds = Math.round((status.pollIntervalMs || 15000) / 1000);
    els.intervalLabel.textContent = seconds + ' 秒';
    els.intervalRange.value = seconds;
    els.intervalNumber.value = seconds;
    updateIntervalLabel(seconds);
    els.stableLabel.textContent = '连续确认 ' + (status.stablePolls || 2) + ' 次';
    els.stablePolls.value = status.stablePolls || 2;

    var last = status.lastPoll || state.polls[0];
    els.lastPollTime.textContent = last && last.at ? '上次轮询：' + formatClock(last.at) : '尚未轮询';
    els.footerPort.textContent = status.port ? '本机服务 :' + status.port : '本机服务';
    if (state.config) els.outputDir.textContent = state.config.outputDir || '—';
    if (status.lastError) state.lastError = status.lastError;
    if (els.sidebarStatus) {
      els.sidebarStatus.textContent = !connected ? '离线' : working ? '总结中' : enabled ? '运行中' : '已暂停';
      els.sidebarDot.className = 'dot ' + (!connected ? 'offline' : working ? 'working' : enabled ? 'running' : 'paused');
    }
    tickCountdown();
  }

  function tickCountdown() {
    var status = state.status || {};
    var enabled = Boolean(status.enabled);
    var next = Number(status.nextPollAt || 0);
    var interval = Math.max(3000, Number(status.pollIntervalMs || 15000));
    if (!state.connected) {
      els.nextPoll.textContent = '—';
      els.ringProgress.style.strokeDashoffset = '201';
      return;
    }
    if (!enabled) {
      els.nextPoll.textContent = '暂停';
      els.ringProgress.style.strokeDashoffset = '201';
      return;
    }
    if (!next) {
      els.nextPoll.textContent = '—';
      els.ringProgress.style.strokeDashoffset = '201';
      return;
    }
    var remain = Math.max(0, next - Date.now());
    els.nextPoll.textContent = remain > 0 ? (remain / 1000).toFixed(1) + 's' : '即将';
    var progress = Math.min(1, Math.max(0, 1 - remain / interval));
    els.ringProgress.style.strokeDashoffset = String(201 * (1 - progress));
  }

  var DECISION = {
    new: { label: '新视频', dot: 'new' },
    seen: { label: '已处理 · 静默', dot: 'seen' },
    'non-course': { label: '非课程 · 静默', dot: 'non-course' },
    'no-browser': { label: '非浏览器', dot: '' },
    'no-video': { label: '未识别视频', dot: '' },
    'stable-wait': { label: '等待稳定', dot: '' },
    manual: { label: '手动总结', dot: 'new' },
    busy: { label: '任务占用', dot: '' },
    error: { label: '失败', dot: 'error' }
  };

  function renderPolls() {
    var list = state.polls || [];
    if (list.length === 0) {
      els.pollList.innerHTML = '<div class="empty small">还没有轮询记录</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length && i < 40; i++) {
      var poll = list[i];
      var decision = DECISION[poll.decision] || { label: poll.decision || '观察', dot: '' };
      var title = poll.title || poll.message || '—';
      var sub = poll.message || '';
      if (poll.title && poll.message && poll.message !== poll.title) sub = poll.message;
      html += '<div class="poll-item">' +
        '<span class="poll-dot ' + esc(decision.dot) + '"></span>' +
        '<div class="poll-main">' +
          '<div class="poll-title">' + esc(title) + '</div>' +
          '<div class="poll-sub">' + esc(sub || (poll.app || '')) + '</div>' +
          '<span class="poll-badge ' + esc(decision.dot) + '">' + esc(decision.label) + '</span>' +
        '</div>' +
        '<span class="poll-time">' + esc(formatClock(poll.at)) + '</span>' +
      '</div>';
    }
    els.pollList.innerHTML = html;
  }

  var STAGES = ['classify', 'fetch', 'summarize', 'docs', 'done'];
  function renderTask() {
    var task = state.task;
    var done = state.done;
    if (!task) {
      var hasHistory = Boolean(state.done && state.done.title);
      els.taskBadge.textContent = hasHistory ? '历史笔记' : '待命';
      els.taskBadge.className = 'mini-badge ' + (hasHistory ? 'success' : '');
      els.taskProgress.style.width = hasHistory ? '100%' : '0%';
      qsa('#stepper .step').forEach(function (step) { step.className = 'step' + (hasHistory ? ' done' : ''); });
      return;
    }
    var currentIndex = STAGES.indexOf(task.stage);
    if (currentIndex < 0) currentIndex = 0;
    qsa('#stepper .step').forEach(function (step) {
      var stage = step.getAttribute('data-step');
      var index = STAGES.indexOf(stage);
      step.className = 'step';
      if (task.stage === 'done') {
        step.classList.add('done');
      } else if (task.stage === 'error') {
        if (index === currentIndex) step.classList.add('error');
      } else if (index < currentIndex) {
        step.classList.add('done');
      } else if (index === currentIndex) {
        step.classList.add('active');
      }
    });
    var progress = Number(task.progress || 0);
    if (task.stage === 'done') progress = 100;
    els.taskProgress.style.width = Math.max(0, Math.min(100, progress)) + '%';
    var labels = { classify: '分类中', fetch: '抓取中', summarize: '总结中', docs: '生成 Word', done: '完成', error: '失败' };
    els.taskBadge.textContent = labels[task.stage] || '处理中';
    els.taskBadge.className = 'mini-badge ' + (task.stage === 'done' ? 'success' : task.stage === 'error' ? 'error' : 'active');
    els.taskTitle.textContent = task.title || (done && done.title) || '正在总结…';
    els.taskStatus.textContent = task.message || '—';
    els.summaryContent.hidden = false;
    els.summaryEmpty.hidden = true;
  }

  function scheduleSummaryRender() {
    if (summaryTimer) return;
    summaryTimer = setTimeout(function () {
      summaryTimer = null;
      renderSummary();
    }, 160);
  }

  function extractMindmaps(markdown) {
    var blocks = [];
    var re = /\`\`\`mermaid([\s\S]*?)\`\`\`/g;
    var match;
    while ((match = re.exec(String(markdown || ''))) !== null) {
      var body = match[1] || '';
      if (!/^\s*mindmap\b/im.test(body)) continue;
      blocks.push(body.split('\n'));
    }
    return blocks;
  }

  function extractSection(markdown, title) {
    var lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]) && lines[i].replace(/^##\s+/, '').trim().indexOf(title) >= 0) {
        start = i + 1;
        break;
      }
    }
    if (start < 0) return '';
    var out = [];
    for (var j = start; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) break;
      out.push(lines[j]);
    }
    return out.join('\n').trim();
  }

  function renderSummary() {
    var hasContent = Boolean(state.summary || state.done || state.task);
    els.summaryEmpty.hidden = hasContent;
    els.summaryContent.hidden = !hasContent;
    if (!hasContent) return;
    var done = state.done || {};
    var title = done.title || (state.task && state.task.title) || '';
    els.taskTitle.textContent = title || '正在总结…';
    if (done.title) {
      els.taskStatus.textContent = [done.subject, done.coverage ? '覆盖：' + done.coverage : '', done.durationMs ? '耗时 ' + Math.round(done.durationMs / 1000) + 's' : ''].filter(Boolean).join(' · ');
    }
    var keywords = done.keywords || [];
    els.summaryKeywords.innerHTML = keywords.slice(0, 8).map(function (keyword) {
      return '<span class="keyword">' + esc(keyword) + '</span>';
    }).join('');
    var meta = [];
    if (done.subject) meta.push('<span class="chip">学科：' + esc(done.subject) + '</span>');
    if (done.coverage) meta.push('<span class="chip">' + esc(done.coverage) + '</span>');
    if (done.isNewSubject) meta.push('<span class="chip">新学科 · 已创建学习手册</span>');
    if (done.docxError) meta.push('<span class="chip" style="color:#b91c1c">Word 生成失败</span>');
    els.summaryMeta.innerHTML = meta.join('');
    var cover = done.pic || '';
    if (cover) {
      els.summaryCover.src = cover;
      els.summaryCover.hidden = false;
      els.summaryCoverFallback.hidden = true;
    } else {
      els.summaryCover.hidden = true;
      els.summaryCoverFallback.hidden = false;
    }
    qsa('#summaryTabs button').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tab') === state.summaryTab);
    });
    var tab = state.summaryTab;
    var text = state.summary || '';
    if (tab === 'mindmap') {
      var blocks = extractMindmaps(text);
      if (blocks.length) {
        els.summaryMarkdown.innerHTML = blocks.map(function (lines) { return renderMindmap(lines); }).join('');
      } else {
        els.summaryMarkdown.innerHTML = '<p class="muted">思维导图将在总结完成后显示。</p>';
      }
    } else if (tab === 'insights') {
      var insights = extractSection(text, '弹幕与评论区洞察');
      if (insights) els.summaryMarkdown.innerHTML = renderMarkdown(insights);
      else els.summaryMarkdown.innerHTML = '<p class="muted">这次总结还没有弹幕/评论洞察。</p>';
    } else if (text) {
      els.summaryMarkdown.innerHTML = renderMarkdown(text) + (state.task && state.task.stage === 'summarize' ? '<p class="streaming-caret"></p>' : '');
    } else if (state.task) {
      els.summaryMarkdown.innerHTML = '<p class="muted">正在准备内容…</p>';
    }
    var noteDocx = done.noteDocx || null;
    els.btnOpenDoc.disabled = !noteDocx;
    els.btnDownloadDoc.disabled = !noteDocx;
    els.btnOpenDoc.title = noteDocx || '暂无文档';
    els.btnDownloadDoc.title = noteDocx || '暂无文档';
  }

  function inlineMarkdown(text) {
    var value = esc(text);
    value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return value;
  }

  function renderMindmap(codeLines) {
    var nodes = [];
    for (var i = 0; i < codeLines.length; i++) {
      var raw = codeLines[i];
      if (!raw.trim() || /^\s*mindmap\b/i.test(raw)) continue;
      var indent = raw.length - raw.replace(/^\s+/, '').length;
      var text = raw.trim().replace(/^root\s*/, '');
      for (var pass = 0; pass < 3; pass++) {
        if (/^\(\(.*\)\)$/.test(text)) text = text.slice(2, -2);
        else if (/^\[.*\]$/.test(text)) text = text.slice(1, -1);
        else if (/^\(.*\)$/.test(text)) text = text.slice(1, -1);
        else if (/^\{.*\}$/.test(text)) text = text.slice(1, -1);
        else break;
      }
      text = text.trim();
      if (text) nodes.push({ indent: indent, text: text });
    }
    if (!nodes.length) return '';
    var minIndent = Math.min.apply(null, nodes.map(function (node) { return node.indent; }));
    var root = nodes[0].text;
    var list = '<div class="mindmap"><div class="mindmap-root">' + esc(root) + '</div><ul class="mindmap-list">';
    for (var j = 1; j < nodes.length; j++) {
      var level = Math.max(1, Math.min(4, Math.round((nodes[j].indent - minIndent) / 2)));
      list += '<li class="mindmap-node lvl-' + level + '">' + esc(nodes[j].text) + '</li>';
    }
    list += '</ul></div>';
    return list;
  }

  function renderMarkdown(markdown) {
    var lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    var html = [];
    var listType = null;
    var inCode = false;
    var codeLang = '';
    var codeLines = [];

    function closeList() {
      if (listType) {
        html.push('</' + listType + '>');
        listType = null;
      }
    }
    function flushCode() {
      if (codeLines.length) {
        if (codeLang === 'mermaid' && codeLines.some(function (line) { return /^\s*mindmap\b/i.test(line); })) {
          html.push(renderMindmap(codeLines));
        } else {
          html.push('<pre><code>' + esc(codeLines.join('\n')) + '</code></pre>');
        }
        codeLines = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        if (inCode) { flushCode(); inCode = false; codeLang = ''; }
        else { closeList(); inCode = true; codeLang = trimmed.slice(3).trim().toLowerCase(); codeLines = []; }
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }
      if (!trimmed) { closeList(); continue; }
      if (/^#{1,4}\s+/.test(trimmed)) {
        closeList();
        var level = trimmed.match(/^#+/)[0].length;
        html.push('<h' + level + '>' + inlineMarkdown(trimmed.replace(/^#+\s+/, '')) + '</h' + level + '>');
        continue;
      }
      if (/^>\s?/.test(trimmed)) {
        closeList();
        html.push('<blockquote>' + inlineMarkdown(trimmed.replace(/^>\s?/, '')) + '</blockquote>');
        continue;
      }
      if (/^---+$/.test(trimmed)) { closeList(); html.push('<hr>'); continue; }
      if (/^[-*]\s+/.test(trimmed)) {
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        var item = trimmed.replace(/^[-*]\s+/, '');
        item = item.replace(/^\[ \]\s+/, '☐ ').replace(/^\[[xX]\]\s+/, '☑ ');
        html.push('<li>' + inlineMarkdown(item) + '</li>');
        continue;
      }
      if (/^\d+[.)]\s+/.test(trimmed)) {
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push('<li>' + inlineMarkdown(trimmed.replace(/^\d+[.)]\s+/, '')) + '</li>');
        continue;
      }
      closeList();
      html.push('<p>' + inlineMarkdown(trimmed) + '</p>');
    }
    if (inCode) flushCode();
    closeList();
    return html.join('');
  }

  function renderHistory() {
    if (!els.historyList) return;
    var tab = state.tab;
    var query = state.query;
    var history = state.history || { subjects: [], videos: [] };
    if (tab === 'subjects') {
      var subjects = (history.subjects || []).filter(function (subject) {
        if (!query) return true;
        return String(subject.name || '').toLowerCase().indexOf(query) >= 0;
      });
      if (!subjects.length) {
        els.historyList.innerHTML = '<div class="empty small">还没有学科记录</div>';
        return;
      }
      els.historyList.innerHTML = subjects.map(function (subject) {
        var manual = subject.manualDocx || '';
        return '<div class="history-item subject-item">' +
          '<div class="subject-icon">' + esc(String(subject.name || '?').slice(0, 1)) + '</div>' +
          '<div class="history-main">' +
            '<div class="history-title">' + esc(subject.name) + '</div>' +
            '<div class="history-sub">' + (subject.count || 0) + ' 个视频' + (subject.keywords && subject.keywords.length ? ' · ' + esc(subject.keywords.slice(0, 4).join(' / ')) : '') + '</div>' +
          '</div>' +
          '<div class="history-actions">' +
            (manual ? '<button class="btn btn-ghost" data-open="' + esc(manual) + '">学习手册</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    } else {
      var videos = (history.videos || []).filter(function (video) {
        if (!query) return true;
        var text = [video.title, video.subject, (video.keywords || []).join(' ')].join(' ').toLowerCase();
        return text.indexOf(query) >= 0;
      });
      if (!videos.length) {
        els.historyList.innerHTML = '<div class="empty small">还没有视频笔记</div>';
        return;
      }
      els.historyList.innerHTML = videos.map(function (video) {
        return '<div class="history-item">' +
          '<div class="history-main">' +
            '<div class="history-title">' + esc(video.title || '未命名视频') + '</div>' +
            '<div class="history-sub">' + esc((video.date || '') + ' · ' + (video.subject || '未归档')) + '</div>' +
          '</div>' +
          '<div class="history-actions">' +
            '<button class="btn btn-ghost" data-video="' + esc(video.key || video.bvid || '') + '">查看</button>' +
            (video.noteDocx ? '<button class="btn btn-ghost" data-doc="' + esc(video.noteDocx) + '">Word</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    els.historyList.querySelectorAll('[data-open]').forEach(function (button) {
      button.addEventListener('click', function () { openPath(button.getAttribute('data-open')); });
    });
    els.historyList.querySelectorAll('[data-doc]').forEach(function (button) {
      button.addEventListener('click', function () { openPath(button.getAttribute('data-doc')); });
    });
    els.historyList.querySelectorAll('[data-video]').forEach(function (button) {
      button.addEventListener('click', function () { switchView('home'); loadVideo(button.getAttribute('data-video')); });
    });
  }

  async function loadVideo(key, scroll) {
    try {
      var data = await fetchJson('/api/video?key=' + encodeURIComponent(key));
      var video = data.video || {};
      state.done = {
        title: video.title,
        subject: video.subject,
        keywords: video.keywords || [],
        coverage: video.coverage ? Object.keys(video.coverage).filter(function (k) { return video.coverage[k]; }).map(function (k) { return ({ desc: '简介', tags: '标签', chapters: '分P', subtitle: '字幕', danmaku: '弹幕', comments: '评论' })[k] || k; }).join(' · ') : '',
        pic: video.pic || '',
        noteDocx: video.noteDocx || null,
        manualDocx: video.manualDocx || null
      };
      state.summary = video.markdown || '';
      state.summaryTab = 'summary';
      state.task = null;
      renderSummary();
      renderTask();
      if (scroll !== false) document.querySelector('.summary-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!state.summary) toast('该记录没有 Markdown 源，可直接打开 Word', '');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function fetchHistory() {
    try {
      var data = await fetchJson('/api/history');
      state.history = { subjects: data.subjects || [], videos: data.videos || [] };
      renderHistory();
      renderSidebarRecent();
      renderLibraryStats();
    } catch (error) {
      /* silent */
    }
  }

  async function boot() {
    cacheEls();
    bindEvents();
    bindOnboarding();
    els.offlineBanner.hidden = true;
    try {
      var quick = await Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/history'),
        fetchJson('/api/autostart').catch(function () { return {}; })
      ]);
      state.status = quick[0];
      state.config = quick[0].config || state.config;
      state.history = { subjects: quick[1].subjects || [], videos: quick[1].videos || [] };
      state.autostart = quick[2] && quick[2].autostart;
      state.connected = true;
      renderAll();
      if (!state.config.onboardingDone) showOnboarding();
      if (state.config.onboardingDone && state.config.updateUrl) setTimeout(checkUpdate, 1200);
      var noActiveTask = !state.status || !state.status.task || state.status.task.stage === 'done' || state.status.task.stage === 'error';
      if (noActiveTask && state.history.videos.length > 0 && !state.summary) {
        loadVideo(state.history.videos[0].key, false);
      }
      fetchJson('/api/llm').then(function (data) {
        state.llm = data;
        renderSettings();
        renderStatus();
      }).catch(function () {});
    } catch (error) {
      state.connected = false;
      els.offlineBanner.hidden = false;
      toast('无法连接 course notes 服务：' + error.message, 'error');
    }
    connect();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdown, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
