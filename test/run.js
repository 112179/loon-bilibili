/* Node 本地测试：用假的 Loon 运行时跑两个脚本，验证请求匹配后的改写结果 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLEAN = path.join(ROOT, "scripts", "bilibili-clean.js");
const SB = path.join(ROOT, "scripts", "sponsorblock.js");

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (extra ? " -> " + extra : ""));
  }
}

function run(scriptPath, opts) {
  const store = opts.store || {};
  const out = { done: null, calls: [], notices: [] };
  const sandbox = {
    $request: opts.request || { url: "" },
    $response: opts.response || { status: 200, body: "" },
    $argument: opts.argument,
    $persistentStore: {
      read(k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      write(v, k) {
        if (v === undefined || v === null) delete store[k];
        else store[k] = String(v);
        return true;
      }
    },
    $httpClient: {
      get(o, cb) {
        out.calls.push(o);
        const res = opts.http ? opts.http(o) : { error: "no-http-mock" };
        setImmediate(() => cb(res.error, res.response, res.data));
      }
    },
    $notification: {
      post(title, subtitle, content, attach) {
        out.notices.push({ title, subtitle, content, attach });
      }
    },
    $done(v) {
      out.done = v === undefined ? {} : v;
    },
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(scriptPath, "utf8"), sandbox, { filename: scriptPath });
  return new Promise(resolve => setTimeout(() => resolve(Object.assign(out, { store })), 30));
}

const FEED_URL = "https://app.bilibili.com/x/v2/feed/index?build=1";
const PLAYER_URL = "https://api.bilibili.com/x/player/wbi/v2?bvid=BV1xx411c7mD&cid=123456789";

function feedBody() {
  return JSON.stringify({
    code: 0,
    data: {
      items: [
        { card_type: "small_cover_v2", card_goto: "av", args: { aid: 1 } },
        { card_type: "cm_video", card_goto: "ad_av", ad_info: { creative_id: 3 } },
        { card_type: "small_cover_v2", card_goto: "av", ad_info: {} },
        { card_type: "small_cover_v2", card_goto: "av", is_ad: 1 },
        { card_type: "small_cover_v2", card_goto: "av", ad_info: { creative_id: 9 } }
      ]
    }
  });
}

function playerBody() {
  return JSON.stringify({
    code: 0,
    data: {
      bvid: "BV1xx411c7mD",
      cid: 123456789,
      view_points: [{ type: 1, from: 100, to: 100, content: "开始", imgUrl: "", logoUrl: "" }]
    }
  });
}

function apiOK() {
  return {
    response: { status: 200 },
    data: JSON.stringify([
      { segment: [12.3, 45.8], cid: "123456789", UUID: "a", category: "sponsor", actionType: "skip" },
      { segment: [46, 50], cid: "123456789", UUID: "b", category: "sponsor", actionType: "mute" },
      { segment: [70, 95.2], cid: "123456789", UUID: "c", category: "selfpromo", actionType: "skip" }
    ])
  };
}

(async () => {
  console.log("\n[1] 去广告脚本");
  {
    const r = await run(CLEAN, {
      request: { url: FEED_URL },
      response: { status: 200, body: feedBody() }
    });
    const items = JSON.parse(r.done.body).data.items;
    ok("3 条广告被移除，保留 2 条正常内容", items.length === 2, "got " + items.length);
    ok("没有误删正常卡片", items[0].args && items[0].args.aid === 1);
    ok("空 ad_info 不算广告，保留", items[1].card_type === "small_cover_v2");
  }
  {
    const r = await run(CLEAN, {
      request: { url: "https://app.bilibili.com/x/v2/splash/list" },
      response: { status: 200, body: JSON.stringify({ code: 0, data: { list: [{ id: 1 }], config: { a: 1 } } }) }
    });
    const d = JSON.parse(r.done.body).data;
    ok("开屏 list 被清空", Array.isArray(d.list) && d.list.length === 0);
    ok("开屏其它配置保留", d.config && d.config.a === 1);
  }
  {
    const r = await run(CLEAN, {
      request: { url: FEED_URL },
      response: { status: 200, body: "not-json" }
    });
    ok("非 JSON 直接放行", r.done && r.done.body === undefined);
  }

  console.log("\n[2] SponsorBlock 脚本");
  {
    const store = {};
    const r = await run(SB, {
      store,
      request: { url: PLAYER_URL },
      response: { status: 200, body: playerBody() },
      argument: { markers: true, notify: true, categories: "sponsor,selfpromo" },
      http: apiOK
    });
    ok("只请求一次 API", r.calls.length === 1, "calls " + r.calls.length);
    ok("带了 bvid 与 cid", /videoID=BV1xx411c7mD/.test(r.calls[0].url) && /cid=123456789/.test(r.calls[0].url));
    ok("categories 是 JSON 数组", decodeURIComponent(r.calls[0].url).includes('categories=["sponsor","selfpromo"]'));
    const data = JSON.parse(r.done.body).data;
    const added = data.view_points.filter(p => /跳过广告/.test(p.content || ""));
    ok("跳过了 mute 片段，只标记 2 段", added.length === 2, "got " + added.length);
    ok("标记在片段结束处", added.map(p => p.from).join(",") === "46,95");
    ok("原有点保留且按时间排序", data.view_points.length === 3 && data.view_points[0].from === 46);
    ok("推送了通知", r.notices.length === 1 && /2 段/.test(r.notices[0].subtitle));
    ok("写入了缓存", !!r.store["sb:v2:BV1xx411c7mD:123456789"]);
  }
  {
    const r = await run(SB, {
      store: {
        "sb:v2:BV1xx411c7mD:123456789": JSON.stringify({ t: Date.now(), s: [[12.3, 45.8, "sponsor"]] })
      },
      request: { url: PLAYER_URL },
      response: { status: 200, body: playerBody() },
      argument: { markers: true, notify: false, categories: "sponsor" },
      http: apiOK
    });
    ok("缓存命中不再请求 API", r.calls.length === 0);
    ok("缓存片段也写入了标记", /跳过广告/.test(r.done.body));
  }
  {
    const r = await run(SB, {
      store: {},
      request: { url: PLAYER_URL },
      response: { status: 200, body: playerBody() },
      argument: { markers: true, notify: true, categories: "sponsor" },
      http: () => ({ response: { status: 404 }, data: "" })
    });
    ok("404 时原样放行", r.done.body === undefined);
    ok("404 时不打扰用户", r.notices.length === 0);
  }
  {
    const store = {};
    for (let i = 0; i < 2; i++) {
      await run(SB, {
        store,
        request: { url: PLAYER_URL },
        response: { status: 200, body: playerBody() },
        argument: { markers: true, notify: false },
        http: () => ({ error: "timeout" })
      });
    }
    const r = await run(SB, {
      store,
      request: { url: PLAYER_URL },
      response: { status: 200, body: playerBody() },
      argument: { markers: true, notify: false },
      http: apiOK
    });
    ok("连续失败后熔断，不再请求", r.calls.length === 0);
  }
  {
    const r = await run(SB, {
      store: {},
      request: { url: "https://api.bilibili.com/x/player/v2?aid=1&cid=2" },
      response: { status: 200, body: playerBody() },
      argument: { markers: true, notify: false },
      http: apiOK
    });
    ok("URL 没有 bvid 时改用响应里的 bvid", r.calls.length === 1);
  }
  {
    const r = await run(SB, {
      store: {},
      request: { url: PLAYER_URL },
      response: { status: 200, body: playerBody() },
      argument: { markers: true, notify: false, categories: "sponsor,bogus" },
      http: apiOK
    });
    ok("未知类别被过滤", decodeURIComponent(r.calls[0].url).includes('categories=["sponsor"]'));
  }
  {
    const body = JSON.parse(playerBody());
    delete body.data.bvid;
    const r = await run(SB, {
      store: {},
      request: { url: "https://api.bilibili.com/x/player/v2?aid=1&cid=2" },
      response: { status: 200, body: JSON.stringify(body) },
      argument: { markers: true, notify: false },
      http: apiOK
    });
    ok("完全拿不到 bvid 时跳过", r.calls.length === 0 && r.done.body === undefined);
  }

  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
