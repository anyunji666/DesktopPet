// ---------- 右键菜单的动作表 + 重建入口（叶子模块，不依赖任何领域模块） ----------
// menu.js 从这里取"点某个菜单项要调的函数"，所以它不用 require 切角色 / 桌面模式 / 设置窗口这些模块；
// 反过来，各领域模块改完状态（切角色、进出桌面模式、改自启动…）后调 rebuildMenu() 重建 state.menu，
// 所以它们也不用 require menu.js。动作表和构建器都由 index.js 在装配时注入，两边不会成环。
const { state } = require('../state');

let actions = {};
let builder = null;

function setMenuActions(map) {
  actions = map;
}

function menuActions() {
  return actions;
}

function setMenuBuilder(fn) {
  builder = fn;
}

// 重建右键菜单并记到 state.menu（菜单会根据 state 里的当前角色 / 场景 / 开关状态重新打勾）
function rebuildMenu() {
  state.menu = builder ? builder() : null;
  return state.menu;
}

module.exports = { setMenuActions, menuActions, setMenuBuilder, rebuildMenu };
