/*!
 * Bilibili SponsorBlock for Loon
 *
 * 在 B 站播放器接口（/x/player/v2、/x/player/wbi/v2）的响应里：
 *   1. 请求 bsbsb.top 的 SponsorBlock 数据；
 *   2. 把每个 skip 片段的「结束时间」写成播放器 view_points 标记，
 *      点进度条上的标记即可跳到广告之后（原生 App 的 seek 只能由用户点击触发）；
 *   3. 可选推送通知，列出片段起止时间。
 *
 * Loon 只能改写 HTTP，无法让官方 App 自动 seek，所以这里不做「自动跳过」的虚假承诺。
 */
(function () {
  "use strict";

  var API_BASE = "https://bsbsb.top/api/skipSegments";
  var CACHE_MS = 6 * 3600 * 1000;
  var BREAK_MS = 30 * 60 * 1000;
  var MAX_WAIT_MS = 1800;

  var arg = (typeof $argument === "object" && $argument) ? $argument : {};
  var wantMarkers = arg.markers !== false;
  var wantNotify = arg.notify === true;
  var categories = normalizeCategories(arg.categories);

  var requestURL = ($request && $request.url) || "";
  var body = ($response && $response.body) || "";
  var json = null;
  var data = null;

  try {
    json = JSON.parse(body);
    data = json && json.data;
  } catch (e) {
    json = null;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    done();
    return;
  }

  var bvid = query(requestURL, "bvid") || String(data.bvid || "");
  var cid = query(requestURL, "cid") || String(data.cid || "");

  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    done();
    return;
  }

  var cacheKey = "sb:v2:" + bvid + ":" + (cid || "0");
  var cached = cacheRead(cacheKey);

  if (cached && Date.now() - cached.t < CACHE_MS) {
    apply(cached.s);
    return;
  }

  var breaker = Number(read("sb:v2:break") || 0);
  if (breaker > Date.now()) {
    if (cached && Array.isArray(cached.s) && cached.s.length) {
      apply(cached.s);
    } else {
      done();
    }
    return;
  }

  var queryString =
    "?videoID=" + encodeURIComponent(bvid) +
    (cid ? "&cid=" + encodeURIComponent(cid) : "") +
    "&categories=" + encodeURIComponent(JSON.stringify(categories)) +
    "&actionTypes=" + encodeURIComponent(JSON.stringify(["skip"]));

  $httpClient.get({
    url: API_BASE + queryString,
    timeout: MAX_WAIT_MS,
    headers: {
      origin: "https://github.com/hanydd/BilibiliSponsorBlock",
      "x-ext-version": "0.5.0"
    }
  }, function (error, response, text) {
    var list = null;

    if (!error && response && response.status === 200 && typeof text === "string") {
      try {
        list = JSON.parse(text);
      } catch (e) {
        list = null;
      }
    }

    if (!Array.isArray(list)) {
      fail();
      return;
    }

    var segments = [];
    var seen = {};

    list.forEach(function (item) {
      if (!item || !Array.isArray(item.segment) || item.segment.length < 2) return;
      if (item.actionType && item.actionType !== "skip") return;

      var start = Number(item.segment[0]);
      var end = Number(item.segment[1]);
      if (!isFinite(start) || !isFinite(end)) return;
      if (start < 0) start = 0;
      if (end <= start + 0.5) return;

      var id = item.UUID || (start + "-" + end);
      if (seen[id]) return;
      seen[id] = 1;

      segments.push([round1(start), round1(end), String(item.category || "")]);
    });

    segments.sort(function (a, b) {
      return a[0] - b[0];
    });

    cacheWrite(cacheKey, { t: Date.now(), s: segments });
    clearFailures();
    apply(segments);
  });

  // ---------- apply ----------

  function apply(segments) {
    var modified = false;

    if (wantMarkers && segments.length) {
      var points = Array.isArray(data.view_points) ? data.view_points.slice() : [];
      var occupied = {};

      points.forEach(function (point) {
        if (point && typeof point.from === "number") occupied[Math.round(point.from)] = 1;
      });

      segments.forEach(function (segment) {
        var end = Math.round(segment[1]);
        if (end <= 0 || occupied[end]) return;
        occupied[end] = 1;

        points.push({
          type: 1,
          from: end,
          to: end,
          content: "跳过广告（" + format(segment[1] - segment[0]) + "）",
          imgUrl: "",
          logoUrl: "",
          team_type: "",
          team_name: ""
        });
        modified = true;
      });

      if (modified) {
        points.sort(function (a, b) {
          return Number(a.from || 0) - Number(b.from || 0);
        });
        data.view_points = points;
      }
    }

    if (wantNotify && segments.length) {
      var shown = segments.slice(0, 4).map(function (segment) {
        return format(segment[0]) + "-" + format(segment[1]);
      });
      if (segments.length > 4) shown.push("等 " + segments.length + " 段");

      try {
        $notification.post(
          "B站赞助片段",
          "共 " + segments.length + " 段 / " + Math.round(totalSeconds(segments)) + " 秒",
          shown.join("、"),
          { clipboard: bvid }
        );
      } catch (e) {}
    }

    if (modified) {
      done({ body: JSON.stringify(json) });
    } else {
      done();
    }
  }

  // ---------- store ----------

  function read(key) {
    try {
      return $persistentStore.read(key);
    } catch (e) {
      return null;
    }
  }

  function cacheRead(key) {
    try {
      var raw = read(key);
      if (!raw) return null;
      var value = JSON.parse(raw);
      if (!value || typeof value.t !== "number" || !Array.isArray(value.s)) return null;
      return value;
    } catch (e) {
      return null;
    }
  }

  function cacheWrite(key, value) {
    try {
      $persistentStore.write(JSON.stringify(value), key);
    } catch (e) {}
  }

  function fail() {
    try {
      var count = Number(read("sb:v2:fails") || 0) + 1;
      $persistentStore.write(String(count), "sb:v2:fails");
      if (count >= 2) {
        $persistentStore.write(String(Date.now() + BREAK_MS), "sb:v2:break");
      }
    } catch (e) {}

    if (cached && Array.isArray(cached.s) && cached.s.length) {
      apply(cached.s);
    } else {
      done();
    }
  }

  function clearFailures() {
    try {
      $persistentStore.write(undefined, "sb:v2:fails");
      $persistentStore.write(undefined, "sb:v2:break");
    } catch (e) {}
  }

  // ---------- utils ----------

  function done(value) {
    $done(value || {});
  }

  function query(url, name) {
    var match = new RegExp("[?&]" + name + "=([^&#]+)").exec(url);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function normalizeCategories(value) {
    var fallback = ["sponsor", "selfpromo"];
    var known = {
      sponsor: 1,
      selfpromo: 1,
      interaction: 1,
      intro: 1,
      outro: 1,
      preview: 1,
      music_offtopic: 1,
      poi_highlight: 1,
      filler: 1
    };
    if (typeof value !== "string" || !value.trim()) return fallback;

    var list = value.split(",").map(function (item) {
      return item.trim().toLowerCase();
    }).filter(function (item) {
      return !!known[item];
    });

    return list.length ? list : fallback;
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function format(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var minutes = Math.floor(total / 60);
    var rest = total % 60;
    return minutes + ":" + (rest < 10 ? "0" : "") + rest;
  }

  function totalSeconds(segments) {
    return segments.reduce(function (sum, segment) {
      return sum + Math.max(0, segment[1] - segment[0]);
    }, 0);
  }
})();
