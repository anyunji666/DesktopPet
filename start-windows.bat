@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有检测到 Node.js，请先去 https://nodejs.org 安装。
  pause
  exit /b 1
)

if not exist node_modules\ws\package.json (
  echo 正在安装依赖（首次运行或依赖有更新），请稍候...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络，或尝试：npm install --registry=https://registry.npmmirror.com
    pause
    exit /b 1
  )
)

if exist node_modules\electron\dist\electron.exe (
  echo 正在启动桌面宠物...
) else (
  echo 首次启动需要下载 Electron 运行程序（约100-200MB），请保持网络畅通，耐心等待...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  pushd node_modules\electron
  call node install.js
  popd
  if errorlevel 1 (
    echo [错误] Electron 下载失败，请检查网络后重新运行 windows第一次启动点这个.bat。
    pause
    exit /b 1
  )
  echo 正在启动桌面宠物...
)

call npm start
if errorlevel 1 (
  echo [错误] 启动失败，上面是详细报错信息。
  pause
)
