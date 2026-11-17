/*!
 * Bilibili ad cleaner for Loon
 * 处理 app.bilibili.com 的开屏与首页信息流接口：
 *   /x/v2/splash/list
 *   /x/v2/splash/show
 *   /x/v2/feed/index
 * 只删除明确的广告卡片，其它字段原样保留；解析失败直接放行。
 */
(function () {
  "use strict";

  var result = {};

  try {
    var url = ($request && $request.url) || "";
    var body = ($response && $response.body) || "";
    if (typeof body !== "string" || !body) {
      $done({});
      return;
    }

    var json = JSON.parse(body);
    if (!json || json.code !== 0 || !json.data || typeof json.data !== "object") {
      $done({});
      return;
    }

    var data = json.data;
    var changed = false;

    if (/\/x\/v2\/splash\//.test(url)) {
      // 开屏接口本身就是广告位，清空列表，保留配置字段
      if (Array.isArray(data.list) && data.list.length) {
        data.list = [];
        changed = true;
      }
    } else {
      ["items", "item"].forEach(function (key) {
        if (!Array.isArray(data[key])) return;
        var kept = data[key].filter(function (item) {
          return !isAd(item);
        });
        if (kept.length !== data[key].length) {
          data[key] = kept;
          changed = true;
        }
      });
    }

    result = changed ? { body: JSON.stringify(json) } : {};
  } catch (e) {
    result = {};
  }

  $done(result);

  function isAd(card) {
    if (!card || typeof card !== "object" || Array.isArray(card)) return false;

    if (card.is_ad === true || card.is_ad === 1 || card.is_ad === "1") return true;
    if (card.cm_mark === 1 || card.cm_mark === "1") return true;

    if (card.ad_info && typeof card.ad_info === "object") {
      for (var k in card.ad_info) {
        if (Object.prototype.hasOwnProperty.call(card.ad_info, k)) return true;
      }
    }

    if (/^(ad_av|ad_web|ad_player|ad_banner)$/.test(String(card.card_goto || ""))) return true;
    if (/^cm($|_)/.test(String(card.card_type || ""))) return true;

    return false;
  }
})();
