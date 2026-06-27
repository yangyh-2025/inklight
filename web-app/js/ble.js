// ============================================
// BLE 通信模块 - Web Bluetooth API
// ============================================

const BLE_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const BLE_TX_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb'; // Notify (ESP32→手机)
const BLE_RX_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb'; // Write  (手机→ESP32)

const MSG_STROKE_DATA = 0x01;
const MSG_PROJECTION_START = 0x02;
const MSG_PROJECTION_STOP = 0x03;
const MSG_CONFIG = 0x04;
const MSG_ACK = 0x05;
const MSG_NACK = 0x06;

let bleDevice = null;
let bleServer = null;
let rxCharacteristic = null; // Write: 手机→ESP32
let txCharacteristic = null; // Notify: ESP32→手机
let isConnected = false;
let mtu = 20;

export function isWebBluetoothSupported() {
  return !!(navigator && navigator.bluetooth);
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function connect() {
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'InkLight-' }],
      optionalServices: [BLE_SERVICE_UUID]
    });

    bleDevice.addEventListener('gattserverdisconnected', onDisconnect);

    bleServer = await bleDevice.gatt.connect();
    const service = await bleServer.getPrimaryService(BLE_SERVICE_UUID);

    txCharacteristic = await service.getCharacteristic(BLE_TX_UUID);
    rxCharacteristic = await service.getCharacteristic(BLE_RX_UUID);

    await txCharacteristic.startNotifications();
    txCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);

    mtu = Math.min(bleDevice.gatt?.mtu || 185, 220);

    isConnected = true;
    return { success: true, mtu };
  } catch (err) {
    isConnected = false;
    return { success: false, error: err.message };
  }
}

export async function disconnect() {
  if (bleDevice && bleDevice.gatt.connected) {
    await bleDevice.gatt.disconnect();
  }
  isConnected = false;
  bleDevice = null;
  bleServer = null;
  rxCharacteristic = null;
  txCharacteristic = null;
}

function onDisconnect() {
  isConnected = false;
  window.dispatchEvent(new CustomEvent('ble-disconnect'));
}

function handleNotification(event) {
  const data = new Uint8Array(event.target.value.buffer);
  if (data[0] === MSG_ACK || data[0] === MSG_NACK) {
    window.dispatchEvent(new CustomEvent('ble-ack', {
      detail: { type: data[0], seq: data[1] }
    }));
  }
}

// ---- 发送命令 (带 CRC) ----

function buildCommand(type) {
  // 帧: [0xAA|0x55|type|0|0|0|0|CRC8]
  const frame = new Uint8Array(8);
  frame[0] = 0xAA;
  frame[1] = 0x55;
  frame[2] = type;
  // CRC 计算范围: [type, 0, 0, 0, 0] — 5 字节
  const hdr = frame.subarray(2, 7);
  frame[7] = crc8(hdr);
  return frame;
}

export async function sendProjectionStart() {
  if (!isConnected || !rxCharacteristic) throw new Error('设备未连接');
  await rxCharacteristic.writeValueWithoutResponse(buildCommand(MSG_PROJECTION_START));
}

export async function sendProjectionStop() {
  if (!isConnected || !rxCharacteristic) throw new Error('设备未连接');
  await rxCharacteristic.writeValueWithoutResponse(buildCommand(MSG_PROJECTION_STOP));
}

// ---- 发送笔画数据 ----

export async function sendStrokes(strokes) {
  if (!isConnected || !rxCharacteristic) throw new Error('设备未连接');

  const payload = serializeStrokes(strokes);
  const effectiveSize = mtu - 8; // 8 字节帧头
  const totalPackets = Math.ceil(payload.length / effectiveSize);

  for (let i = 0; i < totalPackets; i++) {
    const start = i * effectiveSize;
    const end = Math.min(start + effectiveSize, payload.length);
    const chunk = payload.subarray(start, end);
    const seq = i + 1; // 1-based

    const frame = new Uint8Array(chunk.length + 8);
    frame[0] = 0xAA;
    frame[1] = 0x55;
    frame[2] = MSG_STROKE_DATA;
    frame[3] = 0;                 // stroke index (保留)
    frame[4] = totalPackets;
    frame[5] = seq;
    frame[6] = chunk.length & 0xFF;
    frame.set(chunk, 8);

    // CRC 计算: [type(1)+stroke(1)+total(1)+seq(1)+payloadLen(1)] + payload
    const crcData = new Uint8Array(5 + chunk.length);
    crcData.set(frame.subarray(2, 7));  // header bytes 2-6
    crcData.set(chunk, 5);
    frame[7] = crc8(crcData);

    await rxCharacteristic.writeValueWithoutResponse(frame);

    if (seq % 4 === 0) {
      await sleep(12);
    }
  }
}

// ---- 序列化 ----

function serializeStrokes(strokes) {
  // 每笔: [color(1B)|weight(1B)|stroke_index(2B)|pointCount(2B)|points(N×5B)]
  const buffers = [];
  let totalSize = 0;

  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    const colorCode = parseColor(st.color);
    const weight10 = Math.min(255, Math.max(1, Math.round((st.weight || 2) * 10)));

    const segs = st.points || st.segments || [];
    const pts = segs.map(s => {
      const pt = s.point || s;
      return { x: pt.x ?? s.x ?? 0, y: pt.y ?? s.y ?? 0, t: pt.t ?? s.time ?? s.t ?? 0 };
    }).filter(p => p.x !== undefined && p.y !== undefined);

    if (pts.length < 2) continue; // 跳过无效笔画

    const headerSize = 6;  // color(1)+weight(1)+stroke_index(2)+pointCount(2)
    const buf = new ArrayBuffer(headerSize + pts.length * 5);
    const view = new DataView(buf);

    view.setUint8(0, colorCode);
    view.setUint8(1, weight10);
    view.setUint16(2, i, true);          // stroke_index
    view.setUint16(4, pts.length, true);  // pointCount

    for (let j = 0; j < pts.length; j++) {
      const off = headerSize + j * 5;
      view.setUint16(off,     Math.min(65535, Math.round(pts[j].x)), true);
      view.setUint16(off + 2, Math.min(65535, Math.round(pts[j].y)), true);
      view.setUint8(off + 4,  Math.min(255,   Math.round((pts[j].t || 0) / 10)));
    }

    buffers.push(new Uint8Array(buf));
    totalSize += buf.byteLength;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const b of buffers) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

function parseColor(c) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string') {
    if (c.includes('#ff2020') || c.includes('ff2020') && c.includes('#20ff20') || c.includes('20ff20')) return 0x03;
    if (c.includes('20') && c.includes('ff') && c.includes('20ff20')) return 0x03;
  }
  // 从笔画对象读取 color code
  // 默认返回红色
  const s = String(c || '');
  if (s.includes('20ff20') || s.includes('#20ff20')) return 0x02; // green
  if (s.includes('ff2020') || s.includes('#ff2020') || s.includes('red')) return 0x01; // red
  if (s.includes('ff2020') && s.includes('20ff20')) return 0x03; // dual
  return 0x01;
}

// ---- CRC8 (与 ESP32 完全一致: poly=0x07, init=0x00) ----

function crc8(data) {
  let crc = 0x00;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1);
      crc &= 0xFF;
    }
  }
  return crc;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function getConnectionState() {
  return isConnected;
}
