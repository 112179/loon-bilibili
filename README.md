# 哔哩哔哩空降助手（SponsorBlock）· Loon 插件

把 [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) 的数据接进 Loon：

- **自动跳过视频里的恰饭片段**：播放到广告开头约 2 秒时，自动跳到片段结束；
- **去开屏/首页信息流广告**（可选）；
- 不改播放器、不越狱，用的是 B 站自己的弹幕「空降」指令。

> 之前那版没反应的原因：B 站 App 的播放器/信息流走的是 **gRPC + Protobuf**（`grpc.biliapi.net`），不是 JSON 接口。新版改为拦截 **弹幕接口 DmSegMobile**，通过 `airborne` 弹幕让播放器自己 seek。

---

## 一、原理：为什么这次能真跳

1. App 播放视频时会请求：

```
POST https://grpc.biliapi.net/bilibili.community.service.dm.v1.DM/DmSegMobile
```

2. 弹幕 protobuf 的 `DanmakuElem` 有一个 `action` 字段；当它的值是：

```
airborne:<毫秒>
```

播放器会「空降」到该毫秒位置。

3. 插件在**请求阶段**：
   - 解析请求里的 `pid`（aid）、`oid`（cid）；
   - 查 SponsorBlock 拿到 `actionType=skip` 的片段；
   - 自己请求真实的弹幕响应；
   - 在每个片段**开始后 2 秒**插入一条弹幕：
     - `mode=5`（顶部弹幕）
     - `content=空指部已就位`
     - `action=airborne:<片段结束毫秒>`
   - 把改过的响应直接返回给 App（request script 的 fake response）。

4. 播放到广告开头约 2 秒，弹幕引擎执行 `airborne`，跳到广告结束处。

> 这个思路来自 kokoryh 的公开 Loon 插件（Kelee 插件中心），本仓库是独立实现，只保留最小必要逻辑。

---

## 二、安装自动跳过插件（推荐）

```text
https://cdn.jsdelivr.net/gh/112179/loon-bilibili@v1.1.0/BilibiliSponsorBlock-auto.plugin
```

一键导入：

```text
loon://import?plugin=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2F112179%2Floon-bilibili%40v1.1.0%2FBilibiliSponsorBlock-auto.plugin
```

或手动：Loon → 配置 → 插件 → 右上角 `+` → 粘贴 URL。

### 装完必须做

1. **Loon 已连接**（状态栏有 VPN 图标）；
2. Loon → 配置 → MitM → 安装证书，并在系统「设置 → 通用 → VPN 与设备管理」里信任；
3. **开启 MitM over HTTP/2**（关键：gRPC 走 HTTP/2，不开就拦截不到）；
4. 完全退出 B 站 App（上滑杀掉）再打开。

### 验证是否生效

打开这个测试视频：

```
BV1UwsP69EYg
```

它在 **3:07–4:15** 有一段赞助。播放到 **3:09** 左右应该：

- 顶部出现一条「空指部已就位」；
- 进度自动跳到 **4:15**。

如果没有任何反应，看 Loon → 日志里有没有 `空降助手` 的记录：

- 没有记录 → 没命中 DmSegMobile 请求：检查 MitM-over-HTTP/2、证书、插件启用状态；
- 有记录但没跳 → 你的 App 版本可能改了 `airborne` 指令，把日志发我。

---

## 三、可选：去开屏/首页广告

如果只想让首页干净一点，可以额外装旧版清理插件（和空降助手不冲突）：

```text
https://cdn.jsdelivr.net/gh/112179/loon-bilibili@v1.0.2/BilibiliSponsorBlock-simple.plugin
```

它处理 `app.bilibili.com/x/v2/(splash|feed)` 的 JSON 接口，兼容所有 Loon 版本。新版 App 如果已经改成 gRPC，首页广告可能清不掉，属于正常。

---

## 四、已知限制

| 限制 | 说明 |
| --- | --- |
| 只支持有 SponsorBlock 数据的视频 | 冷门视频没人提交就没有片段 |
| 只处理 `category=sponsor` | 默认不跳 `selfpromo`/`intro`，需要可改脚本里的 `category` |
| 只支持 UGC 视频 | 番剧/PGC 的弹幕接口不同，暂不处理 |
| App 版本相关 | `airborne` 是 B 站内部指令，未来版本可能改；改了就失效 |
| 片段太短不跳 | 小于 5 秒的片段会被过滤 |
| 首次请求多 1–3 秒 | 要等 SponsorBlock + 真实弹幕响应；之后走 6 小时缓存 |
| 需要 MitM-over-HTTP/2 | 不开启无法拦截 gRPC |

---

## 五、旧版 JSON 插件（了解即可）

仓库里还有两个旧文件：

- `BilibiliSponsorBlock.plugin` / `-legacy.plugin`：处理 JSON 播放器接口，把片段结束时间写进 `view_points`，在进度条上做标记；
- `BilibiliSponsorBlock-simple.plugin`：旧语法的去开屏/首页广告。

它们适合旧版 App 或网页接口；**新版 App 请用空降助手**。

---

## 六、Loon 插件开发教程（对照本插件）

### 1. 插件文件结构

```
#!name=插件名
#!desc=说明
#!author=作者
#!date=2026-11-17

[Argument]
...（可选）

[Rule]
DOMAIN, example.com, PROXY

[Script]
http-request ^https?:\/\/example\.com\/api script-path=https://.../a.js, requires-body=true, binary-body-mode=true, timeout=10, tag=xxx

[MITM]
hostname = example.com
```

### 2. `#!` 元数据

| 字段 | 作用 |
| --- | --- |
| `#!name` / `#!desc` / `#!author` | 名称、说明、作者 |
| `#!homepage` / `#!icon` | 主页、图标 |
| `#!system` / `#!system_version` | 支持系统与最低版本 |
| `#!loon_version` | 最低 Loon 版本 |
| `#!date` / `#!tag` | 日期、分类 |
| `#!type` | `normal` / `parser` |
| `#!source` | 下载地址 SHA-256，用于校验地址 |

### 3. `[Argument]`（Build 733+）

```
name = input,"Loon",type=string,tag=名称
region = select,"CN","US","JP",tag=地区
enabled = switch,true,tag=启用
```

- `input` / `select` / `switch`；
- `type=` 决定传给脚本的类型：`string` / `number` / `boolean`；
- 脚本里读 `$argument.name`；可以用 `{${name}, ${region}}` 传对象。

### 4. `[Script]`：新旧语法

**旧版（兼容性最好）**：

```
http-request ^https?:\/\/... script-path=https://.../a.js, requires-body=true, binary-body-mode=true, timeout=10, tag=xxx
http-response ^https?:\/\/... script-path=https://.../b.js, requires-body=true, timeout=10, tag=xxx
```

**新版（Loon 3.5.1 build 983+）**：

```
request  if ${url} ~= /.../ then script("a.js") with requires_body=true, binary_body_mode=true
response if ${url} ~= /.../ then script("b.js") with requires_body=true
cron "0 8 * * *" then script("c.js") with timeout=300
```

旧版更稳；新版适合需要条件表达式、插件参数的场景。

### 5. `[MITM]`

```
[MITM]
hostname = grpc.biliapi.net, app.bilibili.com
```

HTTPS 不改写就不用开 MITM；要改 Body 必须开，并在 Loon 里装证书。**gRPC 还要开 MitM-over-HTTP/2。**

### 6. 脚本 API

| 对象 | 用途 |
| --- | --- |
| `$request` | `url`、`method`、`headers`、`body` |
| `$response` | `status`、`headers`、`body` |
| `$argument` | 插件参数 |
| `$done({})` | 放行 |
| `$done({body})` | 改响应 |
| `$done({response:{...}})` | request 脚本直接返回响应 |
| `$httpClient.get/post` | 脚本内请求；`binary-mode:true` 拿 Uint8Array，`alpn:"h2"` 走 HTTP/2 |
| `$persistentStore.read/write` | 持久化字符串；`write(undefined,key)` 删单个 key |
| `$notification.post` | 通知 |
| `$utils.ungzip` | 解 gzip（gRPC 响应常用） |

### 7. 改 gRPC 的关键点

1. gRPC Body = **5 字节帧头 + protobuf**：`[压缩标志(0/1)] [4 字节长度] [payload]`；
2. 压缩标志为 1 时用 `$utils.ungzip(payload)`；
3. 改完重新组帧时可以把标志设为 0（未压缩），但要删掉响应头里的 `grpc-encoding`；
4. `grpc-status` 可能在 header 或 `h2_trailers`，返回时补 `grpc-status: 0`；
5. request 脚本要拿真实响应：用 `$httpClient.post` 带原 URL、headers、body，`alpn:"h2"`、`binary-mode:true`；
6. 最后 `$done({response:{status, headers, body}})`。

### 8. 调试

- Loon → 日志，按 `tag` 搜；
- 脚本里 `console.log`；
- 先用 `curl --http2` 验证 gRPC 接口；
- 改 Body 前 `console.log` 前几百字节，确认帧头和字段。

### 9. 常见坑

| 坑 | 处理 |
| --- | --- |
| 改了 Body 不生效 | 忘了 `requires-body=true` |
| gRPC 拿不到 Body | 没开 MitM-over-HTTP/2 |
| 请求脚本拿不到响应 | 用 `$httpClient` 自己请求，再返回 `response` |
| 返回体是乱码 | `binary-body-mode=true` / `binary-mode:true` |
| 大整数 varint 编错 | 用 `% 128`，不要用 `& 127`（会截断 32 位） |
| 响应被压缩 | 用 `$utils.ungzip`，返回前删 `grpc-encoding`/`content-encoding` |
| 一条请求命中多个规则 | Request/Response 各只执行第一条完整命中的规则 |

---

## 七、本地测试

```bash
node test/run.js    # JSON 清理 + view_points 标记：22 项
node test/skip.js   # gRPC 空降注入：19 项
```

`test/skip.js` 覆盖：DmSegMobile 解析、BVID 转换、SponsorBlock 过滤、gRPC 帧、gzip、注入字段、缓存、无数据、type 过滤、grpc-status。

---

## 八、致谢

- SponsorBlock 数据：[@hanydd/BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock) 与 `bsbsb.top`
- `airborne` 弹幕思路：kokoryh（Kelee 插件中心）
- 插件归档参考：[Yjwj205/loon-kelee-archive](https://github.com/Yjwj205/loon-kelee-archive)

仅用于个人学习与自用，请遵守 B 站用户协议。
