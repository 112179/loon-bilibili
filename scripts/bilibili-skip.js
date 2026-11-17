/*!
 * Bilibili SponsorBlock 空降助手（Loon request script）
 *
 * 原理：
 *   B 站 App 播放视频时会请求 bilibili.community.service.dm.v1.DM/DmSegMobile 拿弹幕。
 *   弹幕的 DanmakuElem 有一个 action 字段；当 action 为 "airborne:<毫秒>" 时，
 *   播放器会「空降」到该毫秒位置。
 *
 *   本脚本在 DmSegMobile 请求阶段：
 *     1. 解析请求里的 pid(aid) / oid(cid)；
 *     2. 查 SponsorBlock 拿到赞助片段；
 *     3. 自己去请求真实的弹幕响应；
 *     4. 在每个片段开始后 2 秒的位置插入一条 action=airborne:<片段结束> 的弹幕；
 *     5. 把改过的响应直接返回给 App（request script 的 fake response）。
 *
 *   这样播放到广告开头约 2 秒时，App 会自动跳到广告结束处。
 *
 * 说明：字段编号来自 bilibili.community.service.dm.v1 的 protobuf 定义，
 *       action=airborne 的用法参考了 kokoryh 的公开 Loon 插件。
 */
(function () {
  "use strict";

  var API = "https://bsbsb.top/api/skipSegments";
  var HOSTS = ["grpc.biliapi.net", "app.bilibili.com"];
  var CACHE_MS = 6 * 3600 * 1000;
  var EMPTY_TTL = 10 * 60 * 1000;
  var MIN_SECONDS = 5;
  var FAKE_OID = 212364987;
  var AIRBORNE_CONTENT = "空指部已就位";

  var request = $request || {};
  var rawBody = toBytes(request.body);
  if (!rawBody || rawBody.length < 6) return pass();

  var payload;
  try {
    payload = unframe(rawBody);
  } catch (e) {
    return pass();
  }

  var fields;
  try {
    fields = readFields(payload);
  } catch (e) {
    return pass();
  }

  var aid = fields[1];
  var cid = fields[2];
  var type = fields[3];

  if (!aid || !cid || type !== 1) return pass();

  var bvid = aidToBvid(aid);
  if (!bvid) return pass();

  var cacheKey = "bsp:1:" + bvid + ":" + cid;
  var cached = readCache(cacheKey);
  var ttl = cached && cached.ok ? CACHE_MS : EMPTY_TTL;
  var useCache = cached && Date.now() - cached.t < ttl;

  var segmentsPromise = useCache ? Promise.resolve(cached.s) : fetchSegments(bvid, cid);

  Promise.all([segmentsPromise, fetchReal(request, rawBody)]).then(function (results) {
    var segments = results[0] || [];
    var real = results[1];

    if (!real) return pass();

    if (!useCache) {
      writeCache(cacheKey, { t: Date.now(), ok: true, s: segments });
    }

    var status = headerValue(real.headers, "grpc-status") || headerValue(real.h2_trailers, "grpc-status");
    if (status && String(status) !== "0") return pass();

    if (!segments.length) {
      return $done({
        response: {
          status: real.status || 200,
          headers: real.headers || {},
          body: real.body,
          h2_trailers: real.h2_trailers
        }
      });
    }

    var out;
    try {
      out = inject(real.body, segments);
    } catch (e) {
      return pass();
    }

    var headers = cleanResponseHeaders(real.headers);
    var trailers = real.h2_trailers;
    if (!headerValue(trailers, "grpc-status")) {
      trailers = Object.assign({}, trailers || {}, { "grpc-status": "0" });
    }

    $done({
      response: {
        status: real.status || 200,
        headers: headers,
        body: out,
        h2_trailers: trailers
      }
    });
  }).catch(function () {
    pass();
  });

  // ---------- 请求真实弹幕 ----------

  function fetchReal(req, frame) {
    var host = hostOf(req.url);
    var list = host === HOSTS[0] ? HOSTS.slice() : [host];
    var index = 0;

    function next() {
      if (index >= list.length) return Promise.resolve(null);
      var url = replaceHost(req.url, list[index++]);

      return new Promise(function (resolve) {
        $httpClient.post({
          url: url,
          headers: cleanRequestHeaders(req.headers),
          body: frame,
          timeout: 3000,
          "binary-mode": true,
          alpn: "h2"
        }, function (error, response, data) {
          if (!error && response && response.status === 200 && data) {
            var bytes = toBytes(data);
            if (bytes && bytes.length) {
              return resolve({
                status: response.status,
                headers: response.headers || {},
                body: bytes,
                h2_trailers: response.h2_trailers
              });
            }
          }
          resolve(next());
        });
      });
    }

    return next();
  }

  // ---------- SponsorBlock ----------

  function fetchSegments(bvid, cid) {
    var url = API +
      "?videoID=" + encodeURIComponent(bvid) +
      "&cid=" + encodeURIComponent(cid) +
      "&category=sponsor";

    return new Promise(function (resolve) {
      $httpClient.get({
        url: url,
        timeout: 3000,
        headers: {
          origin: "https://github.com/kokoryh/Sparkle/blob/master/release/surge/module/bilibili.sgmodule",
          "x-ext-version": "1.0.0"
        }
      }, function (error, response, data) {
        if (error || !response || response.status !== 200 || !data) return resolve([]);

        var list;
        try {
          list = JSON.parse(data);
        } catch (e) {
          return resolve([]);
        }
        if (!Array.isArray(list)) return resolve([]);

        var out = [];
        var seen = {};

        list.forEach(function (item) {
          if (!item || item.actionType !== "skip") return;
          if (!Array.isArray(item.segment) || item.segment.length < 2) return;

          var start = Number(item.segment[0]);
          var end = Number(item.segment[1]);
          if (!isFinite(start) || !isFinite(end)) return;
          if (start < 0) start = 0;
          if (end - start < MIN_SECONDS) return;

          var key = item.UUID || (start + "-" + end);
          if (seen[key]) return;
          seen[key] = 1;

          out.push([start, end]);
        });

        out.sort(function (a, b) { return a[0] - b[0]; });
        resolve(out);
      });
    });
  }

  // ---------- 注入弹幕 ----------

  function inject(frame, segments) {
    var payload = unframe(frame);
    var parts = [payload];
    var total = payload.length;

    segments.forEach(function (segment, index) {
      var elem = encodeDanmaku(segment, index);
      var head = concat([
        encodeVarint((1 << 3) | 2),
        encodeVarint(elem.length)
      ]);
      parts.push(head, elem);
      total += head.length + elem.length;
    });

    var merged = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (part) {
      merged.set(part, offset);
      offset += part.length;
    });

    return reframe(merged);
  }

  function encodeDanmaku(segment, index) {
    var startMs = Math.floor(segment[0] * 1000) + 2000;
    var endMs = Math.floor(segment[1] * 1000);
    var id = 700000000000 + Math.floor(segment[0] * 1000) + index;

    return concat([
      fieldVarint(1, id),                 // id
      fieldVarint(2, startMs),            // progress
      fieldVarint(3, 5),                  // mode: 顶部
      fieldVarint(4, 50),                 // fontsize
      fieldVarint(5, 16777215),           // color
      fieldString(6, "1948dd5d"),         // mid_hash
      fieldString(7, AIRBORNE_CONTENT),   // content
      fieldVarint(8, Math.floor(Date.now() / 1000)), // ctime
      fieldVarint(9, 11),                 // weight
      fieldString(10, "airborne:" + endMs), // action -> 空降
      fieldVarint(11, 0),                 // pool
      fieldString(12, String(id)),        // id_str
      fieldVarint(13, 1310724),           // attr
      fieldString(22, ""),                // animation
      fieldString(23, ""),                // extra
      fieldVarint(24, 0),                 // colorful
      fieldVarint(25, 1),                 // type
      fieldVarint(26, FAKE_OID),          // oid
      fieldVarint(27, 1)                  // dm_from
    ]);
  }

  // ---------- gRPC 帧 ----------

  function unframe(frame) {
    if (!frame || frame.length < 6) throw new Error("short frame");
    var payload = frame.subarray(5);
    if (frame[0] !== 0) return $utils.ungzip(payload);
    return payload;
  }

  function reframe(payload) {
    var out = new Uint8Array(5 + payload.length);
    out[0] = 0;
    out[1] = (payload.length >>> 24) & 255;
    out[2] = (payload.length >>> 16) & 255;
    out[3] = (payload.length >>> 8) & 255;
    out[4] = payload.length & 255;
    out.set(payload, 5);
    return out;
  }

  // ---------- protobuf ----------

  function readFields(bytes) {
    var out = {};
    var pos = 0;

    while (pos < bytes.length) {
      var tag = readVarint(bytes, pos);
      pos = tag[1];
      var field = Math.floor(tag[0] / 8);
      var wire = tag[0] & 7;

      if (wire === 0) {
        var value = readVarint(bytes, pos);
        pos = value[1];
        out[field] = value[0];
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 2) {
        var length = readVarint(bytes, pos);
        pos = length[1] + length[0];
      } else if (wire === 5) {
        pos += 4;
      } else {
        throw new Error("unsupported wire type " + wire);
      }

      if (pos > bytes.length) throw new Error("truncated");
    }

    return out;
  }

  function readVarint(bytes, pos) {
    var result = 0;
    var factor = 1;
    var byte;

    do {
      if (pos >= bytes.length) throw new Error("varint eof");
      byte = bytes[pos++];
      result += (byte & 127) * factor;
      factor *= 128;
    } while (byte & 128);

    return [result, pos];
  }

  function encodeVarint(value) {
    var out = [];
    value = Math.floor(value);

    while (value > 127) {
      out.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    out.push(value % 128);

    return new Uint8Array(out);
  }

  function fieldVarint(number, value) {
    return concat([
      encodeVarint((number << 3) | 0),
      encodeVarint(value)
    ]);
  }

  function fieldString(number, value) {
    var bytes = utf8(value);
    return concat([
      encodeVarint((number << 3) | 2),
      encodeVarint(bytes.length),
      bytes
    ]);
  }

  function concat(parts) {
    var total = 0;
    parts.forEach(function (part) { total += part.length; });

    var out = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (part) {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  function utf8(text) {
    var out = [];
    text = String(text);

    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);

      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xC0 | (code >> 6), 0x80 | (code & 63));
      } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          var point = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          out.push(
            0xF0 | (point >> 18),
            0x80 | ((point >> 12) & 63),
            0x80 | ((point >> 6) & 63),
            0x80 | (point & 63)
          );
          i++;
        } else {
          out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        }
      } else {
        out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
    }

    return new Uint8Array(out);
  }

  // ---------- AV -> BV ----------

  function aidToBvid(aid) {
    try {
      if (typeof BigInt !== "function") return "";

      var table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
      var chars = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
      var last = chars.length - 1;
      var value = (BigInt(1) << BigInt(51) | BigInt(aid)) ^ BigInt(23442827791579);

      while (value > BigInt(0)) {
        chars[last] = table[Number(value % BigInt(58))];
        value = value / BigInt(58);
        last--;
      }

      var swap = chars[3];
      chars[3] = chars[9];
      chars[9] = swap;

      swap = chars[4];
      chars[4] = chars[7];
      chars[7] = swap;

      return chars.join("");
    } catch (e) {
      return "";
    }
  }

  // ---------- 工具 ----------

  function hostOf(url) {
    var match = /^https?:\/\/([^\/]+)/.exec(url || "");
    return match ? match[1] : "";
  }

  function replaceHost(url, host) {
    return String(url).replace(/^https?:\/\/[^\/]+/, "https://" + host);
  }

  function cleanRequestHeaders(headers) {
    var out = {};
    Object.keys(headers || {}).forEach(function (key) {
      if (/^(content-length|host|connection|transfer-encoding)$/i.test(key)) return;
      out[key] = headers[key];
    });
    return out;
  }

  function cleanResponseHeaders(headers) {
    var out = {};
    Object.keys(headers || {}).forEach(function (key) {
      if (/^(content-length|content-encoding|grpc-encoding)$/i.test(key)) return;
      out[key] = headers[key];
    });
    if (!headerValue(out, "grpc-status")) out["grpc-status"] = "0";
    return out;
  }

  function headerValue(headers, name) {
    if (!headers) return undefined;
    var lower = String(name).toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === lower) {
        return headers[key];
      }
    }
    return undefined;
  }

  function toBytes(value) {
    if (!value) return null;
    if (typeof value === "object" && typeof value.length === "number" && typeof value.subarray === "function") {
      return value instanceof Uint8Array ? value : new Uint8Array(value);
    }
    if (typeof value === "string") {
      var out = new Uint8Array(value.length);
      for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
      return out;
    }
    return null;
  }

  function readCache(key) {
    try {
      var raw = $persistentStore.read(key);
      if (!raw) return null;
      var value = JSON.parse(raw);
      if (!value || typeof value.t !== "number" || !Array.isArray(value.s)) return null;
      return value;
    } catch (e) {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      $persistentStore.write(JSON.stringify(value), key);
    } catch (e) {}
  }

  function pass() {
    $done({});
  }
})();
