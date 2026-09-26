# 桌面 MMD 自设宠物

一个跑在桌面上的透明背景 MMD 看板娘：支持切换角色/场景、跳舞、点击互动、语音合成，
以及接 LLM 实现按天记忆的对话功能。

- **作者**：安运
- **版本**：0.1.0 测试版
- **GitHub**：https://github.com/anyunji666/DesktopPet

## 运行

开发环境（需要先装 [Node.js](https://nodejs.org/)）：

```bash
npm install
npm start
```

Windows 用户也可以直接双击根目录下的 `windows第一次启动点这个.bat`（首次会自动装依赖）；
之后日常启动用 `启动宠物.vbs`（后台静默运行，不弹命令行窗口）。
macOS / Linux 用户用 `mac或linux启动.sh`。

## 目录说明

- `Character/`：角色模型（.pmx）及配套语音、台词、骨骼屏蔽等配置
- `Scene/`：可选的背景场景，见 `Scene/README.md`
- `Actions/`：动作/舞蹈动画文件
- `main-modules/`：Electron 主进程，按领域拆分（配置、聊天记录、LLM、窗口菜单等）
- `public/`：渲染进程页面与前端逻辑
