// ============================================
// InkLight ESP32 固件
// 功能: BLE 接收笔画 → 振镜激光投影
// 平台: ESP32-S3 / ESP32-C3
// 框架: Arduino + NimBLE
// ============================================

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <SPI.h>
#include <Wire.h>

// ============================================
// 引脚定义
// ============================================
#define PIN_DAC_CS      5
#define PIN_LASER_RED   25
#define PIN_LASER_GREEN 26
#define PIN_LASER_ENABLE 32   // 安全继电器 (高电平=激光使能)
#define PIN_LED_LASER    15   // 激光指示LED
#define PIN_LED_LOWBATT  33   // 低电指示LED

#define SPI_CLK  18000000  // 18MHz SPI

// ============================================
// 常量
// ============================================
#define SCAN_RATE_HZ      30000
#define SCAN_PERIOD_US    (1000000 / SCAN_RATE_HZ)  // ~33.3µs
#define IDLE_TIMEOUT_MS   5000    // 5秒无动作关激光
#define SHAKE_THRESHOLD   1.5f    // 加速度阈值 (g)
#define MAX_STROKES       256
#define MAX_POINTS_PER_STROKE 4096
#define MAX_PROJECT_DURATION_MS 120000  // 最长投影2分钟

// BLE 协议
#define MSG_STROKE_DATA      0x01
#define MSG_PROJECTION_START 0x02
#define MSG_PROJECTION_STOP  0x03
#define MSG_CONFIG           0x04
#define MSG_ACK              0x05
#define MSG_NACK             0x06

// 颜色
#define COLOR_RED   0x01
#define COLOR_GREEN 0x02
#define COLOR_DUAL  0x03

// ============================================
// 数据结构
// ============================================
struct Point {
  uint16_t x;
  uint16_t y;
  uint8_t  dt;  // 时间偏移 (×10ms)
};

struct Stroke {
  uint8_t  color;
  uint8_t  weight;    // ×10 (2.0mm = 20)
  uint16_t pointCount;
  Point    points[MAX_POINTS_PER_STROKE];
};

struct ProjectData {
  uint16_t strokeCount;
  Stroke*  strokes;      // 动态分配
  uint16_t canvasWidth;
  uint16_t canvasHeight;
};

// ============================================
// 全局状态
// ============================================
static ProjectData g_project = {0, nullptr, 640, 360};
static volatile bool g_projecting = false;
static volatile bool g_emergencyStop = false;
static bool g_laserEnabled = false;

// BLE
static NimBLEServer* pServer = nullptr;
static NimBLECharacteristic* pTxCharacteristic = nullptr; // Notify
static NimBLECharacteristic* pRxCharacteristic = nullptr; // Write

// 接收缓冲
static const size_t RX_BUF_SIZE = 4096;
static uint8_t rxBuffer[RX_BUF_SIZE];
static size_t rxOffset = 0;
static uint8_t rxTotalPackets = 0;
static uint8_t rxExpectedSeq = 0;

// 投影状态
static uint16_t g_currentStroke = 0;
static uint16_t g_currentPoint = 0;
static uint32_t g_scanTick = 0;
static uint32_t g_lastMovementMs = 0;
static uint32_t g_projectionStartMs = 0;

// DAC 输出缓冲 (双缓冲)
static uint16_t g_dacBufA[2];  // X, Y
static uint16_t g_dacBufB[2];
static volatile bool g_useBufA = true;

// MPU6050
static Adafruit_MPU6050 mpu;
static bool g_mpuReady = false;

// 定时器
static hw_timer_t* g_scanTimer = nullptr;

// ============================================
// DAC 操作 (MCP4822 via SPI)
// ============================================
void dacWrite(uint8_t channel, uint16_t value) {
  // MCP4822: 12-bit, 通道A=0x00, 通道B=0x80
  // 增益1x, 输出0-4.096V (Vref=2.048V)
  uint16_t cmd = (channel == 0 ? 0x3000 : 0xB000) | (value & 0x0FFF);
  digitalWrite(PIN_DAC_CS, LOW);
  SPI.transfer16(cmd);
  digitalWrite(PIN_DAC_CS, HIGH);
}

// 坐标映射: 画布坐标 → DAC 值 (0-4095)
// 画布 640×360 → 振镜扫描范围
uint16_t mapX(uint16_t x) {
  // 映射到振镜有效扫描范围 (约整体的 80%)
  uint32_t v = (uint32_t)x * 3200 / 640 + 448;
  return (v > 4095) ? 4095 : (uint16_t)v;
}

uint16_t mapY(uint16_t y) {
  // Y 轴反转 (振镜通常需要镜像)
  uint32_t v = (uint32_t)(360 - y) * 3200 / 360 + 448;
  return (v > 4095) ? 4095 : (uint16_t)v;
}

// ============================================
// 激光控制
// ============================================
void laserOn(uint8_t color) {
  if (g_emergencyStop) return;
  digitalWrite(PIN_LASER_ENABLE, HIGH);
  digitalWrite(PIN_LED_LASER, HIGH);

  switch (color) {
    case COLOR_RED:
      digitalWrite(PIN_LASER_RED, HIGH);
      digitalWrite(PIN_LASER_GREEN, LOW);
      break;
    case COLOR_GREEN:
      digitalWrite(PIN_LASER_RED, LOW);
      digitalWrite(PIN_LASER_GREEN, HIGH);
      break;
    case COLOR_DUAL:
      digitalWrite(PIN_LASER_RED, HIGH);
      digitalWrite(PIN_LASER_GREEN, HIGH);
      break;
    default:
      digitalWrite(PIN_LASER_RED, HIGH);
      digitalWrite(PIN_LASER_GREEN, LOW);
  }
  g_laserEnabled = true;
}

void laserOff() {
  digitalWrite(PIN_LASER_ENABLE, LOW);
  digitalWrite(PIN_LASER_RED, LOW);
  digitalWrite(PIN_LASER_GREEN, LOW);
  digitalWrite(PIN_LED_LASER, LOW);
  g_laserEnabled = false;
}

// ============================================
// 安全监测任务
// ============================================
void safetyTask(void* param) {
  while (1) {
    // 加速度计晃动检测
    if (g_mpuReady && g_laserEnabled) {
      sensors_event_t a, g, temp;
      mpu.getEvent(&a, &g, &temp);
      float mag = sqrt(a.acceleration.x*a.acceleration.x +
                       a.acceleration.y*a.acceleration.y +
                       a.acceleration.z*a.acceleration.z);
      if (abs(mag - 9.8) > SHAKE_THRESHOLD) {
        // 设备被晃动 → 紧急关断
        g_emergencyStop = true;
        laserOff();
        Serial.println("SAFETY: Shake detected, laser off!");
      }
    }

    // 静止超时检测
    if (g_laserEnabled && (millis() - g_lastMovementMs > IDLE_TIMEOUT_MS)) {
      Serial.println("SAFETY: Idle timeout, laser off!");
      laserOff();
    }

    // 投影超时
    if (g_projecting && (millis() - g_projectionStartMs > MAX_PROJECT_DURATION_MS)) {
      Serial.println("SAFETY: Projection timeout, stopping!");
      g_projecting = false;
      laserOff();
    }

    // 低电检测 (电池电压 < 4.0V)
    // 通过分压电阻接 ADC1_CH0 (GPIO1)
    int adc = analogRead(1);
    float batteryV = adc * (6.0f / 4095.0f) * 2.0f;  // 假设 1/2 分压
    if (batteryV < 4.0f && batteryV > 0.5f) {
      digitalWrite(PIN_LED_LOWBATT, HIGH);
    } else {
      digitalWrite(PIN_LED_LOWBATT, LOW);
    }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ============================================
// 振镜扫描定时器 ISR (Core 0, 最高优先级)
// ============================================
void IRAM_ATTR scanISR() {
  if (!g_projecting || g_emergencyStop) {
    // 不投影时输出中心点 (避免振镜乱跳)
    dacWrite(0, 2048);
    dacWrite(1, 2048);
    return;
  }

  // 从当前笔画当前点读坐标
  if (g_currentStroke < g_project.strokeCount) {
    Stroke& stroke = g_project.strokes[g_currentStroke];
    if (g_currentPoint < stroke.pointCount) {
      Point& pt = stroke.points[g_currentPoint];
      dacWrite(0, mapX(pt.x));
      dacWrite(1, mapY(pt.y));

      g_lastMovementMs = millis();

      // 判断是否需要开关激光 (笔画切换)
      if (g_currentPoint == 0) {
        laserOn(stroke.color);
      }

      // dt 控制播放速度 (原始速度)
      uint32_t targetTick = g_scanTick + pt.dt * (10000 / SCAN_PERIOD_US);
      g_scanTick++;

      g_currentPoint++;
    } else {
      // 当前笔画结束
      g_currentStroke++;
      g_currentPoint = 0;
      // 笔画间短暂关激光
      if (g_currentStroke < g_project.strokeCount) {
        laserOff();
        delayMicroseconds(200); // 200µs 间隔
      }
    }
  } else {
    // 全部笔画结束
    g_projecting = false;
    laserOff();
  }
}

// ============================================
// BLE 回调
// ============================================
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server) override {
    Serial.println("BLE: Client connected");
  }
  void onDisconnect(NimBLEServer* server) override {
    Serial.println("BLE: Client disconnected");
    // 断开时停止投影
    g_projecting = false;
    laserOff();
    NimBLEDevice::startAdvertising();
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    std::string value = pChar->getValue();
    const uint8_t* data = (const uint8_t*)value.data();
    size_t len = value.length();

    if (len < 8) return;

    // 校验帧头
    if (data[0] != 0xAA || data[1] != 0x55) {
      Serial.println("BLE: Invalid frame header");
      return;
    }

    uint8_t type = data[2];
    uint8_t totalPackets = data[4];
    uint8_t seq = data[5];
    uint8_t payloadLen = data[6];
    uint8_t expectedCRC = data[7];

    // CRC 校验
    uint8_t calcCRC = crc8(data + 2, 5);
    calcCRC = crc8Update(calcCRC, data + 8, payloadLen);
    if (calcCRC != expectedCRC) {
      Serial.printf("BLE: CRC mismatch seq=%d\n", seq);
      sendNACK(seq);
      return;
    }

    switch (type) {
      case MSG_STROKE_DATA:
        handleStrokePacket(data + 8, payloadLen, seq, totalPackets);
        break;
      case MSG_PROJECTION_START:
        handleProjectionStart();
        break;
      case MSG_PROJECTION_STOP:
        handleProjectionStop();
        break;
      case MSG_CONFIG:
        // TODO: 配置处理
        break;
    }

    sendACK(seq);
  }

  void handleStrokePacket(const uint8_t* payload, uint8_t len,
                          uint8_t seq, uint8_t total) {
    if (seq == 1) {
      // 新投影的第一包: 重置缓冲
      rxOffset = 0;
      rxTotalPackets = total;
      rxExpectedSeq = 1;
      freeProjectData();
    }

    if (seq != rxExpectedSeq) {
      Serial.printf("BLE: Out of order packet, expected=%d got=%d\n", rxExpectedSeq, seq);
      sendNACK(seq);
      return;
    }

    // 写入环形缓冲
    if (rxOffset + len > RX_BUF_SIZE) {
      Serial.println("BLE: Buffer overflow!");
      rxOffset = 0;
      return;
    }

    memcpy(rxBuffer + rxOffset, payload, len);
    rxOffset += len;
    rxExpectedSeq++;

    if (seq == total) {
      // 接收完成，解析笔画
      parseStrokes();
      rxOffset = 0;
      rxExpectedSeq = 0;
    }
  }
};

// ============================================
// CRC8
// ============================================
uint8_t crc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0x00;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1);
    }
  }
  return crc;
}

uint8_t crc8Update(uint8_t crc, const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1);
    }
  }
  return crc;
}

// ============================================
// 笔画解析
// ============================================
void parseStrokes() {
  freeProjectData();

  size_t offset = 0;
  uint16_t strokeCount = 0;
  // 第一遍: 统计笔画数
  size_t tempOff = 0;
  while (tempOff + 4 <= rxOffset) {
    uint16_t ptCount = rxBuffer[tempOff + 2] | (rxBuffer[tempOff + 3] << 8);
    size_t strokeSize = 4 + ptCount * 5;
    if (tempOff + strokeSize > rxOffset) break;
    strokeCount++;
    tempOff += strokeSize;
  }

  g_project.strokes = (Stroke*)malloc(strokeCount * sizeof(Stroke));
  if (!g_project.strokes) {
    Serial.println("ERROR: malloc failed for strokes");
    return;
  }
  memset(g_project.strokes, 0, strokeCount * sizeof(Stroke));
  g_project.strokeCount = strokeCount;

  // 第二遍: 解析每笔
  for (uint16_t i = 0; i < strokeCount; i++) {
    Stroke& s = g_project.strokes[i];
    s.color = rxBuffer[offset];
    s.weight = rxBuffer[offset + 1];
    s.pointCount = rxBuffer[offset + 2] | (rxBuffer[offset + 3] << 8);

    if (s.pointCount > MAX_POINTS_PER_STROKE) {
      s.pointCount = MAX_POINTS_PER_STROKE;
    }

    for (uint16_t j = 0; j < s.pointCount; j++) {
      size_t poff = offset + 4 + j * 5;
      s.points[j].x = rxBuffer[poff] | (rxBuffer[poff + 1] << 8);
      s.points[j].y = rxBuffer[poff + 2] | (rxBuffer[poff + 3] << 8);
      s.points[j].dt = rxBuffer[poff + 4];
    }

    offset += 4 + s.pointCount * 5;
  }

  Serial.printf("Parsed: %d strokes from %d bytes\n", strokeCount, rxOffset);
}

void freeProjectData() {
  if (g_project.strokes) {
    free(g_project.strokes);
    g_project.strokes = nullptr;
  }
  g_project.strokeCount = 0;
}

// ============================================
// 投影控制
// ============================================
void handleProjectionStart() {
  if (g_project.strokeCount == 0) {
    Serial.println("No stroke data to project");
    return;
  }

  g_projectionStartMs = millis();
  g_currentStroke = 0;
  g_currentPoint = 0;
  g_scanTick = 0;
  g_emergencyStop = false;
  g_projecting = true;
  Serial.println("Projection: START");
}

void handleProjectionStop() {
  g_projecting = false;
  laserOff();
  Serial.println("Projection: STOP");
}

// ============================================
// BLE 通信辅助
// ============================================
void sendACK(uint8_t seq) {
  uint8_t ack[2] = { MSG_ACK, seq };
  if (pTxCharacteristic) {
    pTxCharacteristic->notify(ack, 2);
  }
}

void sendNACK(uint8_t seq) {
  uint8_t nack[2] = { MSG_NACK, seq };
  if (pTxCharacteristic) {
    pTxCharacteristic->notify(nack, 2);
  }
}

// ============================================
// 初始化
// ============================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== InkLight Firmware v1.0 ===");

  // GPIO
  pinMode(PIN_DAC_CS, OUTPUT);
  digitalWrite(PIN_DAC_CS, HIGH);
  pinMode(PIN_LASER_RED, OUTPUT);
  pinMode(PIN_LASER_GREEN, OUTPUT);
  pinMode(PIN_LASER_ENABLE, OUTPUT);
  pinMode(PIN_LED_LASER, OUTPUT);
  pinMode(PIN_LED_LOWBATT, OUTPUT);
  digitalWrite(PIN_LASER_RED, LOW);
  digitalWrite(PIN_LASER_GREEN, LOW);
  digitalWrite(PIN_LASER_ENABLE, LOW);
  digitalWrite(PIN_LED_LASER, LOW);
  digitalWrite(PIN_LED_LOWBATT, LOW);

  // SPI (DAC)
  SPI.begin(18, 19, 23);  // SCK=18, MISO=19, MOSI=23 (ESP32-S3)
  SPI.setFrequency(SPI_CLK);

  // I2C (MPU6050)
  Wire.begin(21, 22);
  if (mpu.begin()) {
    mpu.setAccelerometerRange(MPU6050_RANGE_2_G);
    g_mpuReady = true;
    Serial.println("MPU6050: OK");
  } else {
    Serial.println("MPU6050: NOT FOUND (safety disabled!)");
  }

  // BLE
  NimBLEDevice::init("InkLight-0001");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);  // 最大发射功率

  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  NimBLEService* pService = pServer->createService("0000ffe0-0000-1000-8000-00805f9b34fb");

  // TX: Notify (ESP32 → 手机)
  pTxCharacteristic = pService->createCharacteristic(
    "0000ffe1-0000-1000-8000-00805f9b34fb",
    NIMBLE_PROPERTY::NOTIFY
  );

  // RX: Write (手机 → ESP32)
  pRxCharacteristic = pService->createCharacteristic(
    "0000ffe2-0000-1000-8000-00805f9b34fb",
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  pRxCharacteristic->setCallbacks(new RxCallbacks());

  pService->start();

  // 广播
  NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
  pAdv->addServiceUUID("0000ffe0-0000-1000-8000-00805f9b34fb");
  pAdv->setScanResponse(true);
  pAdv->start();

  Serial.println("BLE: Advertising as 'InkLight-0001'");

  // 安全监测任务 (Core 1)
  xTaskCreatePinnedToCore(safetyTask, "safety", 4096, nullptr, 2, nullptr, 1);

  // 振镜扫描定时器 (Core 0, 30kHz)
  g_scanTimer = timerBegin(0, 80, true);  // 80Mhz / 80 = 1MHz tick
  timerAttachInterrupt(g_scanTimer, &scanISR, true);
  timerAlarmWrite(g_scanTimer, SCAN_PERIOD_US, true);
  timerAlarmEnable(g_scanTimer);

  Serial.println("Ready.");
}

void loop() {
  delay(100);
  // 主循环空闲，所有工作由 ISR + BLE 回调 + safetyTask 处理
}
