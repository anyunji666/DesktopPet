#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有检测到 Node.js，请先去 https://nodejs.org 安装。"
  read -p "按回车键退出..."
  exit 1
fi

if [ ! -f node_modules/ws/package.json ]; then
  echo "正在安装依赖（首次运行或依赖有更新），请稍候..."
  if ! npm install; then
    echo "[错误] 依赖安装失败，请检查网络，或尝试：npm install --registry=https://registry.npmmirror.com"
    read -p "按回车键退出..."
    exit 1
  fi
fi

echo "正在启动桌面宠物..."

# Electron 运行程序是 npm install 时自动下载的，但官方源在国内经常下载失败导致装不上。
# 这里跟 windows第一次启动点这个.bat 一样做个兜底：没检测到 Electron 二进制就换国内镜像单独重试一次下载。
# mac 下是 .app 包，linux 下是普通可执行文件，两种路径都要判断到。
ELECTRON_BIN="node_modules/electron/dist/electron"
ELECTRON_APP="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -f "$ELECTRON_BIN" ] && [ ! -f "$ELECTRON_APP" ]; then
  echo "首次启动需要下载 Electron 运行程序（约100-200MB），请保持网络畅通，耐心等待..."
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  (cd node_modules/electron && node install.js)
  if [ $? -ne 0 ]; then
    echo "[错误] Electron 下载失败，请检查网络后重新运行 mac或linux启动.sh。"
    read -p "按回车键退出..."
    exit 1
  fi
  echo "正在启动桌面宠物..."
fi

npm start
