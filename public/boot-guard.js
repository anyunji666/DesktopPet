// 启动守卫（普通脚本，在模块脚本之前加载）：模块脚本本身出错（比如 WebGL 创建失败）时，
// 后面的页面代码根本不会运行，所以错误记录和"请求主进程重载"必须放在这里。
(function () {
  var api = window.petAPI;
  var log = function (m) {
    try { api.startupLog(m); } catch (e) {}
  };
  log('index.html 已加载，页面脚本开始运行');
  window.addEventListener('error', function (e) {
    log('window.error: ' + e.message + ' @' + (e.filename || '') + ':' + (e.lineno || 0));
    // WebGL 上下文创建失败多半是显卡进程在开机早期还没就绪，让主进程稍后重载一次
    if (/webgl|context/i.test(String(e.message))) {
      try { api.requestReload('WebGL 初始化失败: ' + e.message); } catch (err) {}
    }
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    log('unhandledrejection: ' + ((r && (r.stack || r.message)) || r));
  });
  window.addEventListener('webglcontextlost', function (e) {
    log('WebGL 上下文丢失');
    try { api.requestReload('WebGL 上下文丢失'); } catch (err) {}
  }, true);
})();
