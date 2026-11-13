// ---------- 开机自启动（仅 Windows）----------
// 坑点：开发模式下（没打包成 exe，靠 electron . 跑）如果直接 setLoginItemSettings({ openAtLogin: true })
// 不指定 path/args，Windows 实际注册的是 node_modules\electron\dist\electron.exe 本身、且不带任何参数，
// 开机后 Electron 找不到要加载的项目，只会弹出它自带的默认欢迎页（而不是宠物）。
// 这里改成用子菜单（跟"切换角色"一样悬停即可选）让用户明确选择走哪个入口文件，并显式传入 path + args，
// 从根源上避免这个问题。path 用 System32 下的绝对路径，避免极少数环境 PATH 异常导致注册的命令找不到程序。
const { app } = require('electron');
const path = require('path');
const { ROOT } = require('./root');
const { rebuildMenu } = require('./menu-actions');

function winSystemExe(exeName) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exeName);
}

// 登录项配置，'off' 不对应具体 path/args，只用于表示"未设置"。
// 原来还有个 'console' 模式（用 cmd.exe 包一层 .bat 静默启动，能看到控制台里打印的来往记录），
// 现在来往记录已经改走独立的"LLM调用记录"窗口，不用再靠控制台看了，去掉这个入口。
// 'autostart' 参数让 启动宠物.vbs 先等几秒再启动：开机刚进桌面时磁盘 / CPU / 显卡都在抢资源，
// 太早启动偶尔会卡在加载界面；手动双击 vbs 不带参数，不会延迟
const AUTOLAUNCH_CONFIGS = {
  pet: () => ({ path: winSystemExe('wscript.exe'), args: [path.join(ROOT, '启动宠物.vbs'), 'autostart'] }),
};
// 旧版本注册的登录项（不带 autostart 参数）：仍认作"已开启"，并在启动时迁移成新写法
const LEGACY_AUTOLAUNCH_PET = () => ({ path: winSystemExe('wscript.exe'), args: [path.join(ROOT, '启动宠物.vbs')] });

// 依次用每种配置各自的 path/args 去查，因为 getLoginItemSettings() 不传参数时只会拿"默认可执行文件"
// （即 electron.exe 本身）去比对，查不到我们自己注册的 wscript/cmd 组合，必须传完全一致的 path/args 才准确
function getAutoLaunchMode() {
  for (const mode of Object.keys(AUTOLAUNCH_CONFIGS)) {
    if (app.getLoginItemSettings(AUTOLAUNCH_CONFIGS[mode]()).openAtLogin) return mode;
  }
  if (process.platform === 'win32' && app.getLoginItemSettings(LEGACY_AUTOLAUNCH_PET()).openAtLogin) return 'pet';
  return 'off';
}

// 程序启动时调用：把旧写法的登录项升级成带延迟参数的新写法（同一个注册表项，直接覆盖）；已经是新写法 / 没开自启动则什么也不做
function migrateAutoLaunch() {
  if (process.platform !== 'win32') return;
  try {
    const isNew = app.getLoginItemSettings(AUTOLAUNCH_CONFIGS.pet()).openAtLogin;
    if (!isNew && app.getLoginItemSettings(LEGACY_AUTOLAUNCH_PET()).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, ...AUTOLAUNCH_CONFIGS.pet() });
    }
  } catch (err) {
    console.warn('[pet] 自启动项迁移失败:', err.message);
  }
}

function applyAutoLaunchMode(mode) {
  if (getAutoLaunchMode() === mode) return; // 已经是这个模式，重复点一下不用重新写注册表
  if (mode === 'off') {
    app.setLoginItemSettings({ openAtLogin: false });
  } else if (AUTOLAUNCH_CONFIGS[mode]) {
    app.setLoginItemSettings({ openAtLogin: true, ...AUTOLAUNCH_CONFIGS[mode]() });
  }
  rebuildMenu(); // 重建菜单，让 ✓ 标记跟着切换到刚选的这一项
}

module.exports = { getAutoLaunchMode, migrateAutoLaunch, applyAutoLaunchMode };
