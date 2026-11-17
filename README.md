# 哔哩哔哩净化（SponsorBlock）· Loon 插件

一个把 [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) 的数据接进 Loon 的插件：

- **去广告**：清掉 B 站 App 的开屏广告、首页信息流广告卡片；
- **标记恰饭片段**：把 SponsorBlock 的片段结束时间写进播放器 `view_points`，进度条上出现可点的「跳过广告」标记；
- **通知（可选）**：打开视频时提示有几段广告、分别在什么时间；
- **不做虚假承诺**：Loon 只能改 HTTP，**不能**让官方 App 自动 seek。

> 想要「真·自动跳过」，需要客户端配合：BiliPai、Android 的 LSPosed 模块、浏览器扩展都能做；Loon 插件做不到。

---

## 一、先说清楚：Loon 能做什么、不能做什么

| 能力 | Loon | 说明 |
| --- | --- | --- |
| 改写接口 JSON | ✅ | 去掉广告卡、注入字段 |
| 拦截广告域名 | ✅ | `REJECT` |
| 让播放器自动跳到某个时间 | ❌ | seek 是客户端行为，Loon 没有注入原生 App 的能力 |
| 在进度条上画标记 | ⚠️ 实验性 | 通过改写 `/x/player/v2` 的 `view_points` 实现，取决于 App 版本是否渲染 |
| 通知片段位置 | ✅ | `$notification.post` |

所以本插件的定位是：**把广告清干净，把恰饭片段标出来，点一下标记就能跳过**，而不是替你自动跳。

---

## 二、文件

```
BilibiliSponsorBlock.plugin          新版 Script 语法（Loon ≥ 3.5.1 build 983，带参数界面）
BilibiliSponsorBlock-legacy.plugin   旧版语法（Loon ≤ 3.5.1 build 982）
scripts/bilibili-clean.js            开屏/首页广告清理
scripts/sponsorblock.js              SponsorBlock 查询 + view_points 注入 + 通知
test/run.js                          本地 Node 测试（模拟 Loon 运行时）
```

---

## 三、安装

### 方式 1：直接导入（推荐）

新版 Loon（3.5.1 build 983+）：

```
https://cdn.jsdelivr.net/gh/112179/loon-bilibili@v1.0.1/BilibiliSponsorBlock.plugin
```

一键导入：

```
loon://import?plugin=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2F112179%2Floon-bilibili%40v1.0.1%2FBilibiliSponsorBlock.plugin
```

旧版 Loon（3.5.1 build 982 及更早）：

```
https://cdn.jsdelivr.net/gh/112179/loon-bilibili@v1.0.1/BilibiliSponsorBlock-legacy.plugin
```

GitHub Raw 备用地址（jsDelivr 打不开时）：

```
https://raw.githubusercontent.com/112179/loon-bilibili/main/BilibiliSponsorBlock.plugin
```

### 方式 2：手动添加

Loon → 配置 → 插件 → 右上角 `+` → 粘贴上面的 URL → 保存。

### 装完必做

1. Loon → 配置 → MITM → 生成/安装证书，并在系统「设置 → 通用 → VPN 与设备管理」里信任；
2. 确认 `app.bilibili.com`、`api.bilibili.com` 在 MITM 主机名列表里（插件会自动加）；
3. 完全退出 B 站 App 再打开（App 会缓存接口响应）。

---

## 四、参数

新版插件带参数界面（Loon → 配置 → 插件 → 点插件 → 参数）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 清理广告 `clean` | 开 | 移除开屏和首页信息流里的广告卡片 |
| 进度条标记 `markers` | 开 | 在片段结束处注入 `view_points`（实验性） |
| 片段通知 `notify` | 关 | 打开视频时推送片段起止时间 |
| 片段类别 `categories` | `sponsor,selfpromo` | 逗号分隔，可选 `sponsor` `selfpromo` `interaction` `intro` `outro` `preview` `music_offtopic` `poi_highlight` |

旧版插件没有参数界面，等价于：清理开 + 标记开 + 通知关 + `sponsor,selfpromo`。

---

## 五、工作原理

### 1. 去广告

命中这些接口的响应：

```
https://app.bilibili.com/x/v2/splash/list
https://app.bilibili.com/x/v2/splash/show
https://app.bilibili.com/x/v2/feed/index
```

- 开屏：清空 `data.list`（保留配置字段）；
- 首页：过滤 `data.items` / `data.item` 中 `is_ad`、`cm_mark`、非空 `ad_info`、`card_goto=ad_*`、`card_type=cm_*` 的卡片；
- 解析失败、`code != 0` 一律原样放行，避免把页面搞崩。

### 2. SponsorBlock

命中播放器接口：

```
https://api.bilibili.com/x/player/v2?bvid=BV...&cid=...
https://api.bilibili.com/x/player/wbi/v2?bvid=BV...&cid=...
```

脚本流程：

1. 从 URL（或响应里的 `data.bvid` / `data.cid`）取 `bvid`、`cid`；
2. 查 6 小时缓存，命中直接改写；
3. 请求：

```
GET https://bsbsb.top/api/skipSegments
    ?videoID=<bvid>
    &cid=<cid>
    &categories=["sponsor","selfpromo"]
    &actionTypes=["skip"]
```

4. 只保留 `actionType=skip` 的片段，按 `UUID` 去重；
5. 把每个片段的**结束秒数**追加到 `data.view_points`：

```json
{
  "type": 1,
  "from": 46,
  "to": 46,
  "content": "跳过广告（0:34）",
  "imgUrl": "",
  "logoUrl": "",
  "team_type": "",
  "team_name": ""
}
```

6. 可选：`$notification.post` 推送片段列表；
7. 失败处理：1.8 秒超时；连续失败 2 次后熔断 30 分钟，期间直接用缓存或放行，避免每个视频都卡。

> 为什么标记在「结束时间」而不是「开始时间」？B 站的「看点」标记被点击时会 seek 到 `from`，标在结束处 = 点一下直接跳到广告之后。

---

## 六、已知限制

1. **不能自动 seek**。这是 Loon 的边界，不是脚本能绕过的。
2. **只支持 UGC 视频**（`bvid`）。番剧/PGC 的 `ep_id` 接口没做。
3. **gRPC 接口不支持**。部分新版本 B 站 App 会用 gRPC/Protobuf，Loon 的 `[Script]` 只能处理 HTTP 文本。
4. **`view_points` 标记是实验性的**。不同 App 版本对 `view_points` 的渲染不一致；如果进度条异常，把「进度条标记」关掉即可。
5. **首次打开某个视频最多多等 1.8 秒**（等 SponsorBlock 接口）；之后走 6 小时缓存。
6. **冷门视频没有数据**。SponsorBlock 是社区众包，没人提交就没有片段。
7. **`bsbsb.top` 不可达时**会熔断 30 分钟，不会持续卡视频页。
8. **不处理开屏以外的贴片广告**。B 站贴片广告的接口因版本而异，本插件只做明确的开屏/信息流广告。

---

## 七、Loon 插件开发教程（对照本插件）

### 1. 插件文件长什么样

一个 `.plugin` 就是一份「可复用的子配置」，由 `#!` 元数据 + 若干配置段组成：

```
#!name = 插件名
#!desc = 说明
#!author = 作者
#!date = 2026-11-17

[Argument]
switch1 = switch,true,tag=开关

[Script]
response if ${url} ~= /^https:\/\/api\.example\.com\// then script("https://.../a.js", {${switch1}}) with requires_body=true

[MITM]
hostname = api.example.com
```

### 2. `#!` 元数据

| 字段 | 作用 |
| --- | --- |
| `#!name` | 插件名 |
| `#!desc` | 说明 |
| `#!author` | 作者 |
| `#!homepage` | 主页 |
| `#!icon` | 图标 URL |
| `#!system` / `#!system_version` | 支持的系统与最低版本 |
| `#!loon_version` | 最低 Loon 版本，如 `3.5.1(983)` |
| `#!date` | 版本日期（原样显示） |
| `#!tag` | 分类标签 |
| `#!type` | `normal` / `parser` |
| `#!source` | 下载地址的 SHA-256，用于校验「你装的是不是作者指定的地址」 |

`#!source` 不是签名，只是地址校验：

```bash
printf '%s' 'https://example.com/plugin.lpx' | shasum -a 256
```

### 3. `[Argument]`：给用户一个设置界面

```
name = input,"Loon",type=string,tag=名称,desc=输入一个名称
region = select,"CN","US","JP",tag=地区
price = input,9.99,type=number,tag=价格
enabled = switch,true,tag=启用
```

- `input`：输入框；`select`：单选；`switch`：开关；
- `type=` 决定传给脚本的类型：`string` / `number` / `boolean`（可省略，默认与控件一致）；
- 在 `script(...)` 的第二个参数里用 `{${name}, ${region}}` 传对象，脚本里读 `$argument.name`；
- 也可以 `with enable=${enabled}`、`cron ${cronExpression}` 动态引用。

### 4. `[Script]`：两种语法

**新版（3.5.1 build 983+）**：

```
request  if <条件> then script("a.js" [, 参数]) with <选项>
response if <条件> then script("b.js" [, 参数]) with <选项>
cron <表达式> then script("c.js") with timeout=300
network-changed then script("d.js")
generic then script("e.js")
```

条件支持 `==`、`~=`（正则查找）、`&&`、`||`、`()`；变量有 `${url}`、`${request.method}`、`${request.header['X']}`、`${response.status}`、`${response.header['X']}`、`${插件参数}`。

**旧版（≤ 3.5.1 build 982）**：

```
[Script]
http-request ^https:\/\/... script-path=https://.../a.js, requires-body=true, timeout=10, tag=xxx
http-response ^https:\/\/... script-path=https://.../b.js, requires-body=true, timeout=10, tag=xxx
cron "0 8 * * *" script-path=https://.../c.js, tag=xxx
```

新语法更严格，也更清晰；旧语法仍然能跑。两者不要混在同一个 `[Script]` 段里。

### 5. `with` 选项

| 选项 | 说明 |
| --- | --- |
| `enable` | 是否启用 |
| `tag` | 日志/列表里显示的名字 |
| `timeout` | 脚本超时；HTTP 默认 20s，其它默认 300s |
| `debug` | 输出调试日志 |
| `requires_body` | 等完整 Body 再执行（改 Body 必须开） |
| `binary_body_mode` | Body 用二进制表示（不会自动开 `requires_body`） |

### 6. `[MITM]`

```
[MITM]
hostname = api.example.com, *.example.com
```

只改写不 MITM，HTTPS 响应是密文，脚本拿不到 Body。装完插件要在 Loon 里装证书并信任。

### 7. 脚本里能用的全局对象

| 对象 | 用途 |
| --- | --- |
| `$request` | `url`、`method`、`headers`、`body` |
| `$response` | `status`、`headers`、`body` |
| `$argument` | `[Argument]` 传来的值；字符串 / 对象 / null |
| `$done(obj)` | 结束脚本并提交修改；`$done({})` = 不修改 |
| `$httpClient.get/post` | 脚本内发请求（改响应时常用它查外部数据） |
| `$persistentStore.read/write` | 持久化字符串；`write(undefined, key)` 删单个 key |
| `$notification.post` | 系统通知 |
| `$script.name` / `$loon` / `$environment` | 脚本名、Loon 版本、运行环境 |

**改响应**：

```js
var json = JSON.parse($response.body);
json.data.foo = "bar";
$done({ body: JSON.stringify(json) });
```

**改请求**：

```js
var headers = Object.assign({}, $request.headers);
headers["X-Test"] = "1";
$done({ url: $request.url, headers: headers, body: $request.body });
```

**直接返回响应**（不发上游）：

```js
$done({
  response: {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true })
  }
});
```

**异步**：`$httpClient` 回调里再 `$done`。注意 `timeout` 和在 `with` 里给脚本的超时，别让接口被拖死。

### 8. 调试

1. Loon → 日志 → 看脚本是否命中、有没有报错；
2. 脚本里 `console.log(...)`，日志里能看到；
3. 临时把 `tag` 写清楚，方便定位是哪条规则；
4. 改响应前先 `console.log($response.body.slice(0, 500))`，确认字段名；
5. 用 `curl` 先验证接口：

```bash
curl -s 'https://api.bilibili.com/x/player/v2?bvid=BV1xx411c7mD&cid=123456' \
  -H 'User-Agent: Mozilla/5.0' -H 'Referer: https://www.bilibili.com/' | head -c 800
```

### 9. 常见坑

| 坑 | 处理 |
| --- | --- |
| 改了 Body 不生效 | 忘了 `requires_body=true` |
| 脚本拿到空 Body | 没开 MITM / 没信任证书 / 响应是 gzip（Loon 会解，但需 `requires_body`） |
| 一条请求命中多个规则 | Request/Response 各只执行**第一条**完整命中的规则，把规则写精确 |
| Response 规则不生效 | 新版要求 Response 条件里必须有 URL Guard，且是必要条件 |
| 正则写错 | 用 `/pattern/flags`，`~=` 是「查找」，要整串匹配就加 `^$` |
| 脚本把页面搞崩 | 解析失败一律 `$done({})`，并给 `try/catch` |
| 外部接口慢 | 给 `$httpClient` 设短 `timeout` + 本地缓存 + 熔断 |

---

## 八、本地测试

不需要 iPhone，用 Node 模拟 Loon 运行时：

```bash
cd loon-bilibili
node test/run.js
```

覆盖：广告卡过滤、开屏清空、非 JSON 放行、SponsorBlock 请求参数、mute 过滤、`view_points` 注入、通知、缓存命中、404、熔断、bvid 回退。

---

## 九、真·自动跳过的替代方案

| 平台 | 方案 | 说明 |
| --- | --- | --- |
| iOS | [BiliPai](https://github.com/112179/BiliPai-iOS) | 自带 SponsorBlock，10Hz 检测并 seek |
| Android | [LSPosed 模块](https://github.com/ch6vip/lsposed-bili-sponsorblock) | Hook 播放器，真正自动跳 |
| 浏览器 | [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) | 原项目 |

如果你想让 Loon 也「真跳」，只能走服务端削流（把视频重新切片后回给 App），1 核小机器不现实，不建议。

---

## 十、免责声明

- SponsorBlock 数据来自社区众包，可能有误报/漏报；
- 插件只改写你自己设备上的接口响应，不上传任何账号信息；
- 仅用于个人学习与自用，请遵守 B 站用户协议。
