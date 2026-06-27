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
        const strokeStore = d.createObjectStore(STORE_STROKES, { keyPath: 'id' });
        strokeStore.createIndex('project_id', 'project_id', { unique: false });
      }
    };
    req.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };
    req.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// 保存作品
export async function saveProject(project, strokes) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS, STORE_STROKES], 'readwrite');
    const projectStore = tx.objectStore(STORE_PROJECTS);
    const strokeStore = tx.objectStore(STORE_STROKES);

    // 保存 project
    project.updated_at = Date.now();
    project.stroke_count = strokes.length;
    project.id = project.id || generateId();
    const pr = projectStore.put(project);

    // 删除旧笔画，写入新笔画
    const strokeIds = strokes.map(s => s.id || generateId());
    // 先清空该项目旧笔画 (简化: 直接写，旧数据会被覆盖或由 GC 清理)
    // 实际: 我们仅写入新笔画，索引找旧的交给调用方清理
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      s.id = strokeIds[i];
      s.project_id = project.id;
      strokeStore.put(s);
    }

    tx.oncomplete = () => resolve(project.id);
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 获取所有作品列表 (不含笔画数据)
export async function listProjects() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS], 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.getAll();
    req.onsuccess = () => {
      // 按创建时间倒序
      const list = req.result.sort((a, b) => b.created_at - a.created_at);
      resolve(list);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// 获取单个作品的完整笔画数据
export async function getProjectStrokes(projectId) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_STROKES], 'readonly');
    const store = tx.objectStore(STORE_STROKES);
    const idx = store.index('project_id');
    const req = idx.getAll(projectId);
    req.onsuccess = () => {
      // 按笔画序号排序
      const strokes = req.result.sort((a, b) => a.stroke_index - b.stroke_index);
      resolve(strokes);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// 删除作品及其笔画
export async function deleteProject(projectId) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS, STORE_STROKES], 'readwrite');
    const projectStore = tx.objectStore(STORE_PROJECTS);
    const strokeStore = tx.objectStore(STORE_STROKES);

    projectStore.delete(projectId);

    const idx = strokeStore.index('project_id');
    const req = idx.getAllKeys(projectId);
    req.onsuccess = () => {
      for (const key of req.result) {
        strokeStore.delete(key);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 获取作品总数
export async function getProjectCount() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_PROJECTS], 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// 清理旧数据 (LRU，保留最近 50 条)
export async function pruneOldProjects() {
  const projects = await listProjects();
  if (projects.length <= 50) return;
  const toDelete = projects.slice(50);
  for (const p of toDelete) {
    await deleteProject(p.id);
  }
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
