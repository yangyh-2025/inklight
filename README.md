# InkLight — 墨迹投影

打开浏览器写几个字，墙上的激光一笔一画还原出来。华为「随心画」同款魔法，¥249 开源 DIY。

## 怎么工作

```
手机 Chrome 打开网页 → Canvas 手写 → Web Bluetooth 发送笔画数据
                                              ↓
         墙面 ← 激光振镜扫描 ← ESP32 驱动 DAC ←┘
```

## 项目结构

```
├── web-app/         # Web App (PWA) — 手写输入 + BLE 发送
├── firmware/       # ESP32 固件 — BLE 接收 + 振镜驱动
├── hardware/       # BOM + 接线图
└── docs/pm/        # PM 文档
```

## 快速开始

### 1. 硬件

详见 `hardware/BOM.md`，核心物料 ~¥246。

### 2. Web App

```bash
cd web-app
# 用任意 HTTP 服务器启动 (HTTPS 必需，Web Bluetooth 要求安全上下文)
npx serve . --ssl
# 或在 GitHub Pages 上托管
```

手机 Chrome 打开 `https://localhost:3000` (或你的 GitHub Pages URL)。

### 3. ESP32 固件

```bash
cd firmware
# 安装 PlatformIO，然后：
pio run -t upload
```

## 技术栈

| 层 | 技术 |
|------|------|
| Web App | Vanilla JS + Atrament.js + Web Bluetooth API + PWA |
| 固件 | C++ (Arduino) + NimBLE + MCP4822 DAC |
| 硬件 | ESP32-S3 + 20kpps 振镜 + 双色激光 + 4×AA |

## 协议

MIT License — 随便用，随便改，随便卖。
