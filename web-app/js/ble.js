// ============================================
// BLE 通信模块 - Web Bluetooth API
// ============================================

const BLE_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const BLE_TX_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb'; // Notify (ESP32→手机)
const BLE_RX_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb'; // Write  (手机→ESP32)

// 自定义协议常量
const MSG_STROKE_DATA = 0x01;
const MSG_PROJECTION_START = 0x02;
const MSG_PROJECTION_STOP = 0x03;
const MSG_CONFIG = 0x04;
const MSG_ACK = 0x05;
const MSG_NACK = 0x06;

let bleDevice = null;
let bleServer = null;
let rxCharacteristic = null; // 手机写→ESP32
let txCharacteristic = null; // ESP32 Notify→手机
let isConnected = false;
let mtu = 20; // 默认 MTU，连接后协商

// 检查浏览器支持
export function isWebBluetoothSupported() {
  return !!(navigator && navigator.bluetooth);
}

// 检查是否为 iOS (Safari 不支持)
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// 连接设备
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

    // 订阅 ESP32 通知
    await txCharacteristic.startNotifications();
    txCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);

    // 尝试协商 MTU (Android)
    if (bleDevice.gatt && typeof bleDevice.gatt.mtu === 'number') {
      mtu = bleDevice.gatt.mtu;
    }
    // iOS 通常自动协商到 185+
    mtu = Math.min(mtu, 220);

    isConnected = true;
    return { success: true, mtu };
  } catch (err) {
    isConnected = false;
    return { success: false, error: err.message };
  }
}

// 断开连接
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
  // 触发自定义事件，让 app.js 处理 UI 更新
  window.dispatchEvent(new CustomEvent('ble-disconnect'));
}

function handleNotification(event) {
  const data = new Uint8Array(event.target.value.buffer);
  // ESP32 发来的确认 / 状态
  if (data[0] === MSG_ACK || data[0] === MSG_NACK) {
    window.dispatchEvent(new CustomEvent('ble-ack', {
      detail: { type: data[0], seq: data[1] }
    }));
  }
}

// 发送笔画数据 (分包)
export async function sendStrokes(strokes) {
  if (!isConnected || !rxCharacteristic) {
    throw new Error('设备未连接');
  }

  // 将笔画序列化为二进制
  const payload = serializeStrokes(strokes);
  const effectiveSize = mtu - 8; // 减去帧头(8B)
  const packets = splitPackets(payload, effectiveSize, MSG_STROKE_DATA);
  const totalPackets = packets.length;

  for (let seq = 0; seq < totalPackets; seq++) {
    const packet = packets[seq];
    // 帧头 + 包数据
    const frame = new Uint8Array(packet.length + 8);
    frame[0] = 0xAA;
    frame[1] = 0x55;
    frame[2] = MSG_STROKE_DATA;
    frame[3] = 0;            // stroke index (跨包通用)
    frame[4] = totalPackets;  // 总包数
    frame[5] = seq + 1;       // 当前包序号 (1-based)
    frame[6] = packet.length & 0xFF;  // 有效载荷长度
    frame[7] = crc8(packet);
    frame.set(packet, 8);

    await rxCharacteristic.writeValueWithoutResponse(frame);
    // 少量延迟防止蓝牙栈拥塞
    if (seq % 4 === 3) {
      await sleep(10);
    }
  }
}

// 发送投影开始指令
export async function sendProjectionStart() {
  if (!isConnected || !rxCharacteristic) throw new Error('设备未连接');
  const cmd = new Uint8Array([0xAA, 0x55, MSG_PROJECTION_START, 0, 0, 0, 0, 0]);
  cmd[7] = crc8(cmd.subarray(0, 7));
  await rxCharacteristic.writeValueWithoutResponse(cmd);
}

// 发送投影停止指令
export async function sendProjectionStop() {
  if (!isConnected || !rxCharacteristic) throw new Error('设备未连接');
  const cmd = new Uint8Array([0xAA, 0x55, MSG_PROJECTION_STOP, 0, 0, 0, 0, 0]);
  cmd[7] = crc8(cmd.subarray(0, 7));
  await rxCharacteristic.writeValueWithoutResponse(cmd);
}

// 笔画序列化: 每笔 → [颜色1B][粗细1B][点数2B][点序列...]
function serializeStrokes(strokes) {
  const buffers = [];
  let totalSize = 0;

  for (const stroke of strokes) {
    const color = parseColor(stroke.color);
    const weight = Math.round(stroke.weight * 10); // 0.5mm → 5
    const points = stroke.points || stroke.segments?.map(s => ({
      x: s.point?.x ?? s.x,
      y: s.point?.y ?? s.y,
      t: s.time ?? s.t ?? 0
    })) || [];

    const headerSize = 4; // color(1) + weight(1) + pointCount(2)
    const buf = new ArrayBuffer(headerSize + points.length * 5);
    const view = new DataView(buf);

    view.setUint8(0, color);
    view.setUint8(1, Math.min(255, Math.max(0, weight)));
    view.setUint16(2, points.length, true);

    for (let i = 0; i < points.length; i++) {
      const off = headerSize + i * 5;
      view.setUint16(off, Math.round(points[i].x), true);
      view.setUint16(off + 2, Math.round(points[i].y), true);
      view.setUint8(off + 4, Math.min(255, Math.round((points[i].t || 0) / 10)));
    }

    buffers.push(new Uint8Array(buf));
    totalSize += buf.byteLength;
  }

  // 合并所有笔画
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const b of buffers) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

function parseColor(colorStr) {
  // 简单颜色映射
  const map = {
    '#ff2020': 0x01,  // 红
    '#20ff20': 0x02,  // 绿
  };
  if (map[colorStr]) return map[colorStr];
  if (colorStr.includes('ff2020') && colorStr.includes('20ff20')) return 0x03; // 双色
  return 0x01; // 默认红
}

function splitPackets(data, chunkSize, type) {
  const packets = [];
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length);
    packets.push(data.subarray(offset, end));
    offset = end;
  }
  return packets;
}

function crc8(data) {
  let crc = 0x00;
  const poly = 0x07;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ poly) : (crc << 1);
      crc &= 0xFF;
    }
  }
  return crc;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getConnectionState() {
  return isConnected;
}
