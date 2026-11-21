/**
 * 文件云盘2 后端（Cloudflare Pages Functions / Worker）
 *
 * 存储：Cloudflare R2（绑定名 BUCKET）
 * 环境变量：
 *   UPLOAD_PASSWORD （加密变量，可选）写操作口令，默认不校验
 *   ALLOW_ORIGIN    （明文，可选）允许的来源，默认 *
 *
 * 特点：分片上传，单文件可达数 GB（前端按 8MiB 切片，逐片 PUT）。
 */

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });

const TYPE_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const guessType = (name) => {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return TYPE_MAP[ext] || 'application/octet-stream';
};

/** 中文文件名在 Content-Disposition 里需要 RFC5987 编码 */
const disposition = (name, download) => {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const keyOf = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/** 递归列出某个前缀下的所有对象 */
const listAll = async (bucket, prefix) => {
  const out = [];
  let cursor;
  for (;;) {
    const r = await bucket.list({ prefix, limit: 1000, cursor });
    for (const o of r.objects) out.push(o);
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
};

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Password',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': 'X-Total-Count, Content-Disposition',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const bucket = env.BUCKET;
    if (!bucket) return json({ error: '后端未绑定 R2 桶，请检查 BUCKET 绑定' }, 500, cors);

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const passOk = (p) => !env.UPLOAD_PASSWORD || String(p || '') === env.UPLOAD_PASSWORD;
    const headerPass = request.headers.get('X-Password') || '';

    const readBody = async (req) => {
      try {
        const t = await req.text();
        return t ? JSON.parse(t) : {};
      } catch (e) {
        return {};
      }
    };

    try {
      // ---------- 健康检查 ----------
      if (route === '/' || route === '/health') {
        return json({ ok: true, service: 'file-cloud-2', r2: true }, 200, cors);
      }

      // ---------- 目录列表 ----------
      if (request.method === 'GET' && route === '/list') {
        const prefix = keyOf(url.searchParams.get('prefix') || '');
        const pre = prefix ? prefix + '/' : '';
        const cursor = url.searchParams.get('cursor') || undefined;
        const r = await bucket.list({ prefix: pre, delimiter: '/', limit: 500, cursor });
        const folders = (r.delimitedPrefixes || [])
          .map((p) => p.slice(pre.length).replace(/\/$/, ''))
          .filter(Boolean);
        const files = (r.objects || [])
          .filter((o) => o.key !== pre)
          .map((o) => ({
            name: o.key.slice(pre.length),
            key: o.key,
            size: o.size,
            uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
            etag: o.etag,
            type: (o.httpMetadata && o.httpMetadata.contentType) || '',
          }))
          .filter((f) => f.name && f.name.indexOf('/') < 0);
        return json({ prefix, folders, files, cursor: r.cursor || null, truncated: !!r.truncated }, 200, cors);
      }

      // ---------- 站点统计 ----------
      if (request.method === 'GET' && route === '/stats') {
        let count = 0;
        let bytes = 0;
        let cursor;
        for (;;) {
          const r = await bucket.list({ limit: 1000, cursor });
          for (const o of r.objects) {
            if (o.key.endsWith('/')) continue;
            count += 1;
            bytes += o.size;
          }
          if (!r.truncated) break;
          cursor = r.cursor;
        }
        return json({ count, bytes }, 200, cors);
      }

      // ---------- 全局搜索 ----------
      if (request.method === 'GET' && route === '/search') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        if (!q) return json([], 200, cors);
        const all = await listAll(bucket, '');
        const hits = all
          .filter((o) => !o.key.endsWith('/') && o.key.toLowerCase().includes(q))
          .slice(0, 200)
          .map((o) => ({
            key: o.key,
            size: o.size,
            uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
          }));
        return json(hits, 200, cors);
      }

      // ---------- 文件下载 / 预览（支持 Range，便于视频拖动） ----------
      if (request.method === 'GET' && route.startsWith('/file/')) {
        const key = decodeURIComponent(route.slice('/file/'.length));
        if (!key) return json({ error: '缺少文件路径' }, 400, cors);
        const head = await bucket.head(key);
        if (!head) return json({ error: '文件不存在' }, 404, cors);
        const range = request.headers.get('Range') || undefined;
        const obj = await bucket.get(key, range ? { range } : undefined);
        if (!obj) return json({ error: '文件不存在' }, 404, cors);

        const name = key.split('/').pop();
        const ext = String(name).split('.').pop().toLowerCase();
        const risky = ['html', 'htm', 'svg', 'xml'].indexOf(ext) >= 0;
        const h = new Headers(cors);
        h.set('Content-Type', (head.httpMetadata && head.httpMetadata.contentType) || guessType(name));
        h.set('Content-Disposition', disposition(name, url.searchParams.get('download') === '1' || risky));
        h.set('Accept-Ranges', 'bytes');
        h.set('X-Content-Type-Options', 'nosniff');
        h.set('ETag', head.etag);
        h.set('Cache-Control', 'public, max-age=300');
        if (obj.range) {
          const r0 = obj.range;
          if (r0.offset !== undefined) {
            h.set('Content-Range', `bytes ${r0.offset}-${r0.offset + r0.length - 1}/${head.size}`);
          }
          h.set('Content-Length', String(obj.size));
          return new Response(obj.body, { status: 206, headers: h });
        }
        h.set('Content-Length', String(head.size));
        return new Response(obj.body, { status: 200, headers: h });
      }

      // ---------- 写操作：统一校验口令 ----------
      if (request.method === 'POST' || request.method === 'DELETE') {
        const ct = request.headers.get('Content-Type') || '';
        const body = ct.includes('application/json') ? await readBody(request) : {};
        const pass = headerPass || body.password;
        if (!passOk(pass)) return json({ error: '口令不正确' }, 401, cors);

        // 小文件直传（也用于创建 0 字节占位）
        if (route === '/put') {
          const key = keyOf(url.searchParams.get('key'));
          if (!key) return json({ error: '缺少 key' }, 400, cors);
          const name = key.split('/').pop();
          const meta = { contentType: guessType(name) };
          const t = url.searchParams.get('type');
          if (t) meta.contentType = t;
          await bucket.put(key, request.body || new Uint8Array(0), { httpMetadata: meta });
          return json({ ok: true, key }, 200, cors);
        }

        // 新建文件夹（用一个以 / 结尾的空对象占位）
        if (route === '/mkdir') {
          const p = keyOf(body.path);
          if (!p) return json({ error: '缺少文件夹名' }, 400, cors);
          await bucket.put(p + '/', new Uint8Array(0), {
            httpMetadata: { contentType: 'application/x-directory' },
          });
          return json({ ok: true, path: p }, 200, cors);
        }

        // 删除（支持文件与文件夹）
        if (route === '/delete') {
          const keys = Array.isArray(body.keys) ? body.keys : body.key ? [body.key] : [];
          if (!keys.length) return json({ error: '缺少 keys' }, 400, cors);
          let removed = 0;
          for (const raw of keys) {
            const k = String(raw || '');
            if (!k) continue;
            if (k.endsWith('/')) {
              const list = await listAll(bucket, k);
              for (let i = 0; i < list.length; i += 100) {
                const batch = list.slice(i, i + 100).map((o) => o.key);
                if (batch.length) await bucket.delete(batch);
                removed += batch.length;
              }
            } else {
              await bucket.delete(k);
              removed += 1;
            }
          }
          return json({ ok: true, removed }, 200, cors);
        }

        // 改名 / 移动
        if (route === '/move') {
          const from = keyOf(body.from);
          const to = keyOf(body.to);
          if (!from || !to || from === to) return json({ error: '路径无效' }, 400, cors);
          const obj = await bucket.get(from);
          if (!obj) return json({ error: '源文件不存在' }, 404, cors);
          await bucket.put(to, obj.body, {
            httpMetadata: obj.httpMetadata || { contentType: guessType(to.split('/').pop()) },
          });
          await bucket.delete(from);
          return json({ ok: true, from, to }, 200, cors);
        }

        // 文件夹改名 / 移动（逐个对象复制后删除）
        if (route === '/mvdir') {
          const from = keyOf(body.from);
          const to = keyOf(body.to);
          if (!from || !to || from === to) return json({ error: '路径无效' }, 400, cors);
          const list = await listAll(bucket, from + '/');
          for (const o of list) {
            const suffix = o.key.slice(from.length);
            const dst = to + suffix;
            if (dst !== o.key) {
              const obj = await bucket.get(o.key);
              if (obj) {
                await bucket.put(dst, obj.body, {
                  httpMetadata: obj.httpMetadata || { contentType: guessType(dst.split('/').pop()) },
                });
              }
            }
          }
          for (let i = 0; i < list.length; i += 100) {
            const batch = list.slice(i, i + 100).map((o) => o.key);
            if (batch.length) await bucket.delete(batch);
          }
          return json({ ok: true, moved: list.length }, 200, cors);
        }

        // 分片：初始化
        if (route === '/mp/init') {
          const key = keyOf(body.key);
          if (!key) return json({ error: '缺少 key' }, 400, cors);
          const name = key.split('/').pop();
          const mp = await bucket.createMultipartUpload(key, {
            httpMetadata: { contentType: body.type || guessType(name) },
          });
          return json({ key, uploadId: mp.uploadId }, 200, cors);
        }

        // 分片：完成
        if (route === '/mp/complete') {
          const key = keyOf(body.key);
          const uploadId = String(body.uploadId || '');
          const parts = (Array.isArray(body.parts) ? body.parts : [])
            .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
            .filter((p) => p.partNumber > 0 && p.etag)
            .sort((a, b) => a.partNumber - b.partNumber);
          if (!key || !uploadId || !parts.length) return json({ error: '分片信息不完整' }, 400, cors);
          const mp = bucket.resumeMultipartUpload(key, uploadId);
          await mp.complete(parts);
          return json({ ok: true, key, size: body.size || 0 }, 200, cors);
        }

        // 分片：中止
        if (route === '/mp/abort') {
          const key = keyOf(body.key);
          const uploadId = String(body.uploadId || '');
          if (key && uploadId) {
            try {
              await bucket.resumeMultipartUpload(key, uploadId).abort();
            } catch (e) { /* 已经结束就忽略 */ }
          }
          return json({ ok: true }, 200, cors);
        }

        return json({ error: '未知接口 ' + route }, 404, cors);
      }

      // ---------- 分片：上传单片（PUT 二进制） ----------
      if (request.method === 'PUT' && route === '/mp/part') {
        if (!passOk(headerPass)) return json({ error: '口令不正确' }, 401, cors);
        const key = keyOf(url.searchParams.get('key'));
        const uploadId = String(url.searchParams.get('uploadId') || '');
        const n = Number(url.searchParams.get('n'));
        if (!key || !uploadId || !(n > 0)) return json({ error: '缺少分片参数' }, 400, cors);
        if (!request.body) return json({ error: '缺少分片数据' }, 400, cors);
        const mp = bucket.resumeMultipartUpload(key, uploadId);
        const part = await mp.uploadPart(n, request.body);
        return json({ partNumber: part.partNumber, etag: part.etag }, 200, cors);
      }

      return json({ error: '未知接口 ' + route }, 404, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, cors);
    }
  },
};
