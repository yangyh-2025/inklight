// ============================================
// IndexedDB 存储 — 作品本地持久化
// ============================================

const DB_NAME = 'inklight';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_STROKES = 'strokes';

let db = null;

function openDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const d = event.target.result;
      if (!d.objectStoreNames.contains(STORE_PROJECTS)) {
        d.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(STORE_STROKES)) {
        const ss = d.createObjectStore(STORE_STROKES, { keyPath: 'id' });
        ss.createIndex('project_id', 'project_id', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

// 保存/更新作品 (先删旧笔画再写新笔画)
export async function saveProject(project, strokes) {
  const d = await openDB();
  const id = project.id || generateId();
  project.id = id;
  project.updated_at = Date.now();
  project.stroke_count = strokes.length;

  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS, STORE_STROKES], 'readwrite');
    const pStore = tx.objectStore(STORE_PROJECTS);
    const sStore = tx.objectStore(STORE_STROKES);

    pStore.put(project);

    // 清理该项目的旧笔画 (通过索引)
    const idx = sStore.index('project_id');
    const keysReq = idx.getAllKeys(id);
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) sStore.delete(key);

      // 写入新笔画
      for (const s of strokes) {
        const stroke = { ...s };
        stroke.id = stroke.id || generateId();
        stroke.project_id = id;
        // 规范化 point 数据: {x,y,t_offset_ms,pressure}
        if (stroke.points || stroke.segments) {
          const src = stroke.points || stroke.segments;
          stroke.points = src.map(sp => {
            const pt = sp.point || sp;
            return {
              x: pt.x ?? sp.x ?? 0,
              y: pt.y ?? sp.y ?? 0,
              t_offset_ms: pt.t ?? sp.time ?? sp.t ?? 0,
              pressure: sp.pressure ?? sp.p ?? 0.5,
            };
          });
          delete stroke.segments; // 统一用 points
        }
        sStore.put(stroke);
      }
    };

    tx.oncomplete = () => resolve(id);
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 列表 (不含笔画)
export async function listProjects() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS], 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).getAll();
    req.onsuccess = () =>
      resolve(req.result.sort((a, b) => b.created_at - a.created_at));
    req.onerror = (e) => reject(e.target.error);
  });
}

// 获取作品的笔画
export async function getProjectStrokes(projectId) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_STROKES], 'readonly');
    const req = tx.objectStore(STORE_STROKES).index('project_id').getAll(projectId);
    req.onsuccess = () =>
      resolve(req.result.sort((a, b) => (a.stroke_index || 0) - (b.stroke_index || 0)));
    req.onerror = (e) => reject(e.target.error);
  });
}

// 删除作品+笔画
export async function deleteProject(projectId) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS, STORE_STROKES], 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(projectId);

    const idx = tx.objectStore(STORE_STROKES).index('project_id');
    const req = idx.getAllKeys(projectId);
    req.onsuccess = () => {
      for (const k of req.result) tx.objectStore(STORE_STROKES).delete(k);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function pruneOldProjects() {
  const list = await listProjects();
  if (list.length <= 50) return;
  for (const p of list.slice(50)) {
    await deleteProject(p.id);
  }
}

function generateId() {
  return crypto.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
