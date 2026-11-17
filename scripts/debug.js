/*!
 * Loon 调试脚本：确认是否命中 B 站接口
 * 只写日志 + 对关键接口弹通知，不改任何响应。
 */
(function () {
  "use strict";

  var url = ($request && $request.url) || "";
  var method = ($request && $request.method) || "";

  console.log("[BiliDebug] " + method + " " + url);

  var interesting = /\/(x\/player|x\/v2\/(feed|splash)|pgc\/player|x\/web-interface\/view)/.test(url);
  if (!interesting) {
    $done({});
    return;
  }

  var last = 0;
  try {
    last = Number($persistentStore.read("bili:dbg:last") || 0);
  } catch (e) {}

  if (Date.now() - last < 3000) {
    $done({});
    return;
  }

  try {
    $notification.post("B站接口命中", method, url.slice(0, 180));
    $persistentStore.write(String(Date.now()), "bili:dbg:last");
  } catch (e) {}

  $done({});
})();
