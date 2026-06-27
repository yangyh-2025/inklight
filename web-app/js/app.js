// ============================================
// InkLight 主应用逻辑
// ============================================

import * as BLE from './ble.js';
import * as Storage from './storage.js';

// ---- 状态 ----
let atrament = null;
let currentColor = '#ff2020';
let currentWeight = 2;
let isEraser = false;
let recordedStrokes = [];
let isProjecting = false;
let isReplaying = false;     // 回放时跳过录制
let currentProjectId = null;

// ---- DOM 引用 ----
const canvas = document.getElementById('drawing-canvas');
const emptyHint = document.getElementById('empty-hint');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const btnProject = document.getElementById('btn-project');
const btnStopProjection = document.getElementById('btn-stop-projection');
const btnLibrary = document.getElementById('btn-library');
const btnCloseLibrary = document.getElementById('btn-close-library');
const btnClear = document.getElementById('btn-clear');
const btnUndo = document.getElementById('btn-undo');
const btnSave = document.getElementById('btn-save');
const btnEraser = document.getElementById('btn-eraser');
const weightSlider = document.getElementById('weight-slider');
const weightLabel = document.getElementById('weight-label');
const libraryModal = document.getElementById('library-modal');
const libraryList = document.getElementById('library-list');
const libraryEmpty = document.getElementById('library-empty');
const projectionOverlay = document.getElementById('projection-overlay');
const iosWarning = document.getElementById('ios-warning');
const btnDismissIOS = document.getElementById('btn-dismiss-ios');

// ---- 包裹 push 以便自动保存 ----
function installAutoSavePatch(arr) {
  const orig = arr.push.bind(arr);
  arr.push = function (...args) {
    const r = orig(...args);
    scheduleAutoSave();
    return r;
  };
}
installAutoSavePatch(recordedStrokes);

// ---- 初始化 ----
function init() {
  if (BLE.isIOS()) {
    if (!localStorage.getItem('inklight_ios_dismissed')) {
      iosWarning.classList.remove('hidden');
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }

  initAtrament();
  bindEvents();
  updateProjectButton();
}

function initAtrament() {
  function resizeCanvas() {
    const container = document.getElementById('canvas-container');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
    canvas.style.width = container.clientWidth + 'px';
    canvas.style.height = container.clientHeight + 'px';
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  atrament = new Atrament(canvas, {
    color: currentColor,
    weight: currentWeight,
    smoothing: 0.85,
    adaptiveStroke: true,
  });

  atrament.recordStrokes = true;

  // 笔画录制事件
  atrament.addEventListener('strokerecorded', ({ stroke }) => {
    if (isReplaying) return;
    recordedStrokes.push({
      ...stroke,
      color: atrament.color,          // 从实例读取, 不用全局变量
      weight: atrament.weight,
      mode: isEraser ? 'erase' : 'draw',
      stroke_index: recordedStrokes.length,
      timestamp: Date.now()
    });
    emptyHint.style.display = 'none';
    updateProjectButton();
  });

  canvas.addEventListener('touchstart', () => {
    emptyHint.style.display = 'none';
  }, { once: true });
}

// ---- 事件绑定 ----
function bindEvents() {
  btnConnect.addEventListener('click', handleConnect);
  btnDisconnect.addEventListener('click', handleDisconnect);
  btnProject.addEventListener('click', handleProject);
  btnStopProjection.addEventListener('click', handleStopProjection);
  btnLibrary.addEventListener('click', openLibrary);
  btnCloseLibrary.addEventListener('click', closeLibrary);
  btnClear.addEventListener('click', handleClear);
  btnUndo.addEventListener('click', handleUndo);
  btnEraser.addEventListener('click', toggleEraser);
  btnSave.addEventListener('click', handleManualSave);
  weightSlider.addEventListener('input', handleWeightChange);
  btnDismissIOS.addEventListener('click', () => {
    iosWarning.classList.add('hidden');
    localStorage.setItem('inklight_ios_dismissed', '1');
  });

  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color;
      isEraser = false;
      btnEraser.classList.remove('active');
      if (atrament) {
        atrament.mode = 'draw';
        atrament.color = currentColor;
      }
    });
  });

  window.addEventListener('ble-disconnect', () => {
    updateConnectionUI('disconnected');
  });
}

// ---- 连接管理 ----
async function handleConnect() {
  updateConnectionUI('connecting');
  const result = await BLE.connect();
  if (result.success) {
    updateConnectionUI('connected');
    updateProjectButton();
  } else {
    updateConnectionUI('error');
    alert('连接失败: ' + result.error);
  }
}

async function handleDisconnect() {
  await BLE.disconnect();
  updateConnectionUI('disconnected');
  updateProjectButton();
}

function updateConnectionUI(state) {
  statusDot.className = 'dot ' + state;
  switch (state) {
    case 'disconnected':
      statusText.textContent = '未连接';
      btnConnect.classList.remove('hidden');
      btnDisconnect.classList.add('hidden');
      break;
    case 'connecting':
      statusText.textContent = '连接中...';
      btnConnect.classList.add('hidden');
      break;
    case 'connected':
      statusText.textContent = '已连接 ✓';
      btnConnect.classList.add('hidden');
      btnDisconnect.classList.remove('hidden');
      break;
    case 'error':
      statusText.textContent = '连接失败';
      btnConnect.classList.remove('hidden');
      btnDisconnect.classList.add('hidden');
      break;
  }
}

// ---- 投影 ----
async function handleProject() {
  if (!BLE.getConnectionState()) {
    alert('请先连接设备');
    return;
  }
  if (recordedStrokes.length === 0) {
    alert('请先写点什么吧！');
    return;
  }
  if (isProjecting) return;

  isProjecting = true;
  projectionOverlay.classList.remove('hidden');
  btnProject.disabled = true;

  try {
    await BLE.sendProjectionStart();
    await BLE.sendStrokes(recordedStrokes);
  } catch (err) {
    alert('投影失败: ' + err.message);
  } finally {
    isProjecting = false;
    projectionOverlay.classList.add('hidden');
    updateProjectButton();
  }
}

async function handleStopProjection() {
  try {
    await BLE.sendProjectionStop();
  } catch (err) { /* 忽略 */ }
  isProjecting = false;
  projectionOverlay.classList.add('hidden');
  updateProjectButton();
}

// ---- 工具 ----
function handleClear() {
  if (recordedStrokes.length === 0) return;
  if (!confirm('确定清空画布？此操作不可撤销。')) return;
  recordedStrokes = [];
  installAutoSavePatch(recordedStrokes);
  atrament.clear();
  emptyHint.style.display = '';
  updateProjectButton();
}

function handleUndo() {
  if (recordedStrokes.length <= 1) {
    handleClear();
    return;
  }
  isReplaying = true;
  recordedStrokes.pop();
  atrament.clear();
  for (const stroke of recordedStrokes) {
    replayOneStroke(stroke);
  }
  isReplaying = false;
  // 恢复当前笔触
  atrament.mode = isEraser ? 'erase' : 'draw';
  atrament.color = currentColor;
  atrament.weight = currentWeight;
  scheduleAutoSave();
  updateProjectButton();
}

function replayOneStroke(stroke) {
  atrament.mode = stroke.mode || 'draw';
  atrament.color = stroke.color || currentColor;
  atrament.weight = stroke.weight || currentWeight;
  atrament.smoothing = stroke.smoothing || 0.85;

  const segments = stroke.points || stroke.segments || [];
  if (segments.length === 0) return;

  const first = segments[0];
  const firstPoint = first.point || first;
  atrament.beginStroke(firstPoint.x, firstPoint.y);

  let prev = firstPoint;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const pt = seg.point || seg;
    const pressure = seg.pressure ?? seg.p ?? 0.5;
    const result = atrament.draw(pt.x, pt.y, prev.x, prev.y, pressure);
    if (result) prev = { x: result.x, y: result.y };
  }
  const last = segments[segments.length - 1];
  const lastPt = last.point || last;
  atrament.endStroke(lastPt.x, lastPt.y);
}

function toggleEraser() {
  isEraser = !isEraser;
  if (isEraser) {
    btnEraser.classList.add('active');
    atrament.mode = 'erase';
  } else {
    btnEraser.classList.remove('active');
    atrament.mode = 'draw';
    atrament.color = currentColor;
  }
}

function handleWeightChange() {
  currentWeight = parseFloat(weightSlider.value);
  weightLabel.textContent = currentWeight + 'mm';
  if (atrament && !isEraser) {
    atrament.weight = currentWeight;
  }
}

// ---- 作品库 ----
async function openLibrary() {
  libraryModal.classList.remove('hidden');
  await refreshLibrary();
}

function closeLibrary() {
  libraryModal.classList.add('hidden');
}

async function refreshLibrary() {
  const projects = await Storage.listProjects();
  libraryList.innerHTML = '';

  if (projects.length === 0) {
    libraryEmpty.style.display = '';
    libraryList.style.display = 'none';
    return;
  }
  libraryEmpty.style.display = 'none';
  libraryList.style.display = 'grid';

  for (const project of projects) {
    const card = document.createElement('div');
    card.className = 'library-item';

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 160;
    thumbCanvas.height = 90;
    if (project.thumbnail) {
      const img = new Image();
      img.onload = () => thumbCanvas.getContext('2d').drawImage(img, 0, 0, 160, 90);
      img.src = project.thumbnail;
    } else {
      const ctx = thumbCanvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = '#999';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无预览', 80, 50);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = project.name || new Date(project.created_at).toLocaleString('zh-CN');
    meta.innerHTML = `<span>${name}</span><span>${project.stroke_count || 0} 笔</span>`;

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = `
      <button class="replay-btn">投影</button>
      <button class="edit-btn">加载</button>
      <button class="delete-btn danger">删除</button>
    `;

    card.appendChild(thumbCanvas);
    card.appendChild(meta);
    card.appendChild(actions);
    libraryList.appendChild(card);

    card.querySelector('.replay-btn').addEventListener('click', async () => {
      closeLibrary();
      await loadProjectToCanvas(project.id);
      if (BLE.getConnectionState()) await handleProject();
    });
    card.querySelector('.edit-btn').addEventListener('click', async () => {
      closeLibrary();
      await loadProjectToCanvas(project.id);
    });
    card.querySelector('.delete-btn').addEventListener('click', async () => {
      if (confirm('删除「' + name + '」？')) {
        await Storage.deleteProject(project.id);
        if (currentProjectId === project.id) currentProjectId = null;
        await refreshLibrary();
      }
    });
  }
}

async function loadProjectToCanvas(projectId) {
  const strokes = await Storage.getProjectStrokes(projectId);
  if (strokes.length === 0) return;

  currentProjectId = projectId;
  isReplaying = true;
  atrament.clear();
  recordedStrokes = [];

  // 转换 DB 格式 → 回放格式
  for (const s of strokes) {
    const segments = (s.points || []).map(p => ({
      point: { x: p.x, y: p.y },
      time: p.t_offset_ms ?? p.t ?? 0,
      pressure: p.pressure ?? p.p ?? 0.5
    }));
    const stroke = {
      ...s,
      segments,
      color: s.color || '#ff2020',
      weight: s.weight || 2,
      mode: s.mode || 'draw',
      smoothing: s.smoothing || 0.85
    };
    recordedStrokes.push(stroke);
    replayOneStroke(stroke);
  }

  isReplaying = false;
  atrament.mode = isEraser ? 'erase' : 'draw';
  atrament.color = currentColor;
  atrament.weight = currentWeight;
  installAutoSavePatch(recordedStrokes);
  emptyHint.style.display = 'none';
  updateProjectButton();
}

// ---- 工具函数 ----
function updateProjectButton() {
  btnProject.disabled = !BLE.getConnectionState() || recordedStrokes.length === 0;
}

// 自动保存 (每 30 秒节流)
let autoSaveTimeout = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(autoSave, 30000);
}

async function autoSave() {
  if (recordedStrokes.length === 0) return;
  const name = '自动保存 ' + new Date().toLocaleString('zh-CN');
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 160;
  thumbCanvas.height = 90;
  const tctx = thumbCanvas.getContext('2d');
  tctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 160, 90);

  const project = {
    id: currentProjectId || crypto.randomUUID(),
    name: currentProjectId ? undefined : name,
    canvas_width: canvas.width,
    canvas_height: canvas.height,
    created_at: currentProjectId ? undefined : Date.now(),
    thumbnail: thumbCanvas.toDataURL('image/png', 0.5),
  };
  try {
    const savedId = await Storage.saveProject(project, recordedStrokes);
    if (!currentProjectId) currentProjectId = savedId;
    await Storage.pruneOldProjects();
  } catch (e) {
    console.warn('自动保存失败:', e);
  }
}

// ---- 手动保存 ----
async function handleManualSave() {
  if (recordedStrokes.length === 0) return;
  clearTimeout(autoSaveTimeout);
  await autoSave();
  alert('已保存 ✓');
}

// ---- 启动 ----
init();
