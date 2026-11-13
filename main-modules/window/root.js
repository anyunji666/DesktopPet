// 项目根目录（main-modules/window/ 往上两级）：拼 preload.js、启动宠物.vbs 这类根目录下的路径用
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = { ROOT };
