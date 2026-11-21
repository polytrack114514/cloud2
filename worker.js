/**
 * 文件云盘2 后端（Cloudflare Pages Functions / Worker）
 *
 * 存储：GitHub Releases（免绑卡，单文件上限 2GB）
 *   - 每个文件按 8MB 切片，每片是一个 release asset：p.<路径base64url>.<片号>
 *   - 空文件夹用 0 字节 asset 占位：d.<路径base64url>
 *   - 下载时由本 Worker 顺序拉取分片并流式拼接，支持 Range（视频可拖动）
 *
 * 环境变量：
 *   GH_TOKEN        （加密变量，必填）对 REPO 有 Contents: Read and write 的令牌
 *   REPO_OWNER      （明文，必填）polytrack114514
 *   REPO_NAME       （明文，必填）cloud2
 *   TAG             （明文，可选）数据所在的 release tag，默认 cloud2-data
 *   UPLOAD_PASSWORD （加密变量，可选）写操作口令
 *   ALLOW_ORIGIN    （明文，可选）允许的来源，默认 *
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

const disposition = (name, download) => {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const keyOf = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/* ---------- 路径 ⇄ asset 名 ---------- */
const b64url = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64url = (s) => {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const partName = (path, n, zero) => 'p.' + b64url(path) + '.' + n + (zero ? '.0' : '');
const dirName = (path) => 'd.' + b64url(path);

const parseAsset = (name) => {
  if (name.indexOf('d.') === 0) return { kind: 'dir', path: unb64url(name.slice(2)) };
  if (name.indexOf('p.') === 0) {
    const rest = name.slice(2);
    const seg = rest.split('.');
    if (seg.length >= 2) {
      return {
        kind: 'part',
        path: unb64url(seg[0]),
        n: Number(seg[1]),
        zero: seg[2] === '0',
      };
    }
  }
  return null;
};

/** GitHub 不接受 0 字节 asset，用 1 字节占位 */
const PLACEHOLDER = new Uint8Array([120]);

/* ---------- GitHub API ---------- */
const gh = (env, path, opts = {}) =>
  fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + env.GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'file-cloud-2-worker',
      ...(opts.headers || {}),
    },
  });

const tagOf = (env) => env.TAG || 'cloud2-data';

/** 第 1 个桶用基础 tag，之后依次 -2 / -3 …；每个 Release 最多 1000 个 asset */
const MAX_ASSETS = 995;
const shardTag = (base, i) => (i <= 1 ? base : base + '-' + i);
const shardIndex = (base, t) => (t === base ? 1 : (parseInt(String(t).slice(base.length + 1), 10) || 0));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assetUrl = (env, tag, name) =>
  `https://github.com/${env.REPO_OWNER}/${env.REPO_NAME}/releases/download/${tag}/${encodeURIComponent(name)}`;

let shardCache = { key: null, list: [] };

const listRepoReleases = async (env) => {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await gh(env, `/repos/${env.REPO_OWNER}/${env.REPO_NAME}/releases?per_page=100&page=${page}`);
    if (!r.ok) {
      if (r.status === 404) return out;
      throw new Error('读取 Release 列表失败：HTTP ' + r.status);
    }
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    for (const x of j) out.push(x);
    if (j.length < 100) break;
  }
  return out;
};

const createShard = async (env, base, i) => {
  const tag = shardTag(base, i);
  const r = await gh(env, `/repos/${env.REPO_OWNER}/${env.REPO_NAME}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: i <= 1 ? '云盘数据' : '云盘数据 ' + i,
      body: '由「文件云盘2」自动管理，请不要在这里手动上传或删除文件。',
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('创建 Release 失败：HTTP ' + r.status + ' ' + t.slice(0, 180));
  }
  return { rel: await r.json(), count: 0 };
};

/** 按序返回所有分桶，cache：count 为已知 asset 数（undefined 表示未知） */
const loadShards = async (env) => {
  const base = tagOf(env);
  const key = env.REPO_OWNER + '/' + env.REPO_NAME + '@' + base;
  if (shardCache.key === key && shardCache.list.length) return shardCache.list;
  const all = await listRepoReleases(env);
  const re = new RegExp('^' + escapeRe(base) + '-\\d+$');
  const mine = all
    .filter((x) => x.tag_name === base || re.test(x.tag_name))
    .sort((a, b) => shardIndex(base, a.tag_name) - shardIndex(base, b.tag_name))
    .map((rel) => ({ rel, count: undefined }));
  if (!mine.length) mine.push(await createShard(env, base, 1));
  shardCache = { key, list: mine };
  return mine;
};

const listAssets = async (env, relId) => {
  const base = `/repos/${env.REPO_OWNER}/${env.REPO_NAME}/releases/${relId}/assets?per_page=100&page=`;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await gh(env, base + page);
    if (!r.ok) break;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    for (const a of j) out.push(a);
    if (j.length < 100) break;
  }
  return out;
};

const doUpload = async (env, shard, name, bytes) => {
  const u =
    'https://uploads.github.com/repos/' + env.REPO_OWNER + '/' + env.REPO_NAME +
    '/releases/' + shard.rel.id + '/assets?name=' + encodeURIComponent(name);
  const r = await fetch(u, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'file-cloud-2-worker',
    },
    body: bytes,
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('分片上传失败 HTTP ' + r.status + ' ' + t.slice(0, 180));
    err.status = r.status;
    throw err;
  }
  if (typeof shard.count === 'number') shard.count += 1;
  return r.json();
};

const maxAssets = (env) => {
  const n = parseInt(env.SHARD_LIMIT || '', 10);
  return n >= 2 ? n : MAX_ASSETS;
};

/** 往当前最新的桶里写；桶满（≥1000 个 asset）时自动新建下一个桶 */
const uploadAsset = async (env, name, bytes) => {
  const limit = maxAssets(env);
  const shards = await loadShards(env);
  let target = shards[shards.length - 1];
  if (target.count === undefined) target.count = (await listAssets(env, target.rel.id)).length;
  if (target.count >= limit) {
    target = await createShard(env, tagOf(env), shards.length + 1);
    shards.push(target);
    shardCache.list = shards;
  }
  try {
    return await doUpload(env, target, name, bytes);
  } catch (e) {
    // 计数不准（并发上传）时桶可能刚好写满，开新桶重试一次
    if (e.status === 422 && target.count >= limit - 10) {
      const next = await createShard(env, tagOf(env), shards.length + 1);
      shards.push(next);
      shardCache.list = shards;
      return doUpload(env, next, name, bytes);
    }
    // 桶被手工删掉：丢掉缓存重新找最新的桶
    if (e.status === 404) {
      shardCache = { key: null, list: [] };
      const fresh = await loadShards(env);
      const last = fresh[fresh.length - 1];
      if (last.rel.id !== target.rel.id) {
        if (last.count === undefined) last.count = (await listAssets(env, last.rel.id)).length;
        return doUpload(env, last, name, bytes);
      }
    }
    throw e;
  }
};

const delAsset = (env, id) =>
  gh(env, '/repos/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/releases/assets/' + id, { method: 'DELETE' });

/** 建立索引：files: Map(path -> {parts,size,time})，dirs: Set(路径，不含根) */
const buildIndex = async (env) => {
  const shards = await loadShards(env);
  const lists = await Promise.all(shards.map((s) => listAssets(env, s.rel.id)));
  shards.forEach((s, i) => { s.count = lists[i].length; });
  const files = new Map();
  const dirs = new Set();
  const dirAssets = [];
  for (let si = 0; si < lists.length; si++) {
    const tag = shards[si].rel.tag_name;
    for (const a of lists[si]) {
      const p = parseAsset(a.name);
      if (!p) continue;
      const segs = String(p.path).split('/').filter(Boolean);
      if (!segs.length) continue;
      let acc = '';
      if (p.kind === 'dir') {
        for (const s of segs) { acc = acc ? acc + '/' + s : s; dirs.add(acc); }
        dirAssets.push({ path: p.path, id: a.id });
        continue;
      }
      for (let i = 0; i < segs.length - 1; i++) { acc = acc ? acc + '/' + segs[i] : segs[i]; dirs.add(acc); }
      const f = files.get(p.path) || { parts: [], size: 0, time: null };
      const logical = p.zero ? 0 : a.size;
      f.parts.push({ n: p.n, id: a.id, name: a.name, size: logical, url: assetUrl(env, tag, a.name) });
      f.size += logical;
      if (!f.time || String(a.created_at) > String(f.time)) f.time = a.created_at;
      files.set(p.path, f);
    }
  }
  files.forEach((f) => f.parts.sort((a, b) => a.n - b.n));
  return { files, dirs, dirAssets, shards };
};

/** 删除某个文件的全部切片 */
const dropFile = async (env, f) => {
  for (const p of f.parts) {
    try { await delAsset(env, p.id); } catch (e) { /* 已删除则忽略 */ }
  }
};

/* ---------- Range ---------- */
const parseRange = (h, size) => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '') {
    const len = parseInt(m[2], 10);
    if (!len) return null;
    start = Math.max(0, size - len);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
  }
  if (isNaN(start) || isNaN(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
};

/** 把若干分片按字节区间拼成一条流 */
const mergeStream = (parts, start, end) => {
  const ranges = [];
  let off = 0;
  for (const p of parts) {
    const ps = off;
    const pe = off + p.size - 1;
    off += p.size;
    const s = Math.max(start, ps);
    const e = Math.min(end, pe);
    if (s <= e) ranges.push({ url: p.url, from: s - ps, to: e - ps });
  }
  let idx = 0;
  return new ReadableStream({
    async pull(controller) {
      if (idx >= ranges.length) { controller.close(); return; }
      const r = ranges[idx++];
      const resp = await fetch(r.url, { headers: { Range: 'bytes=' + r.from + '-' + r.to } });
      if (!resp.ok || !resp.body) throw new Error('分片读取失败 HTTP ' + resp.status);
      const reader = resp.body.getReader();
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        controller.enqueue(c.value);
      }
    },
  });
};

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Password',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Content-Disposition',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (!env.GH_TOKEN || !env.REPO_OWNER || !env.REPO_NAME) {
      return json({ error: '后端未配置：缺少 GH_TOKEN / REPO_OWNER / REPO_NAME' }, 500, cors);
    }

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
      if (route === '/' || route === '/health') {
        return json({ ok: true, service: 'file-cloud-2', storage: 'github-releases', tag: tagOf(env) }, 200, cors);
      }

      /* ---------- 目录列表 ---------- */
      if (request.method === 'GET' && route === '/list') {
        const prefix = keyOf(url.searchParams.get('prefix'));
        const idx = await buildIndex(env);
        const folders = [];
        idx.dirs.forEach((d) => {
          if (!d) return;
          if (prefix && d.indexOf(prefix + '/') !== 0) return;
          const rest = prefix ? d.slice(prefix.length + 1) : d;
          if (rest && rest.indexOf('/') < 0) folders.push(rest);
        });
        const files = [];
        idx.files.forEach((f, path) => {
          const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
          if (dir !== prefix) return;
          files.push({
            name: path.split('/').pop(),
            key: path,
            size: f.size,
            uploaded: f.time,
            etag: String(f.parts.length),
            type: guessType(path),
          });
        });
        folders.sort((a, b) => a.localeCompare(b, 'zh-CN'));
        return json({ prefix, folders, files, cursor: null, truncated: false }, 200, cors);
      }

      /* ---------- 统计 ---------- */
      if (request.method === 'GET' && route === '/stats') {
        const idx = await buildIndex(env);
        let bytes = 0;
        idx.files.forEach((f) => { bytes += f.size; });
        return json({ count: idx.files.size, bytes }, 200, cors);
      }

      /* ---------- 搜索 ---------- */
      if (request.method === 'GET' && route === '/search') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        if (!q) return json([], 200, cors);
        const idx = await buildIndex(env);
        const hits = [];
        idx.files.forEach((f, path) => {
          if (path.toLowerCase().indexOf(q) >= 0) hits.push({ key: path, size: f.size, uploaded: f.time });
        });
        hits.sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'));
        return json(hits.slice(0, 200), 200, cors);
      }

      /* ---------- 下载 / 预览 ---------- */
      if (request.method === 'GET' && route.indexOf('/file/') === 0) {
        const key = decodeURIComponent(route.slice('/file/'.length));
        if (!key) return json({ error: '缺少文件路径' }, 400, cors);
        const idx = await buildIndex(env);
        const f = idx.files.get(key);
        if (!f || !f.parts.length) return json({ error: '文件不存在' }, 404, cors);

        const name = key.split('/').pop();
        const ext = String(name).split('.').pop().toLowerCase();
        const risky = ['html', 'htm', 'svg', 'xml'].indexOf(ext) >= 0;
        const total = f.size;
        const h = new Headers(cors);
        h.set('Content-Type', guessType(name));
        h.set('Content-Disposition', disposition(name, url.searchParams.get('download') === '1' || risky));
        h.set('Accept-Ranges', 'bytes');
        h.set('X-Content-Type-Options', 'nosniff');
        h.set('Cache-Control', 'public, max-age=300');

        const rg = parseRange(request.headers.get('Range'), total);
        if (!total) {
          h.set('Content-Length', '0');
          return new Response(null, { status: 200, headers: h });
        }
        if (rg) {
          h.set('Content-Range', 'bytes ' + rg.start + '-' + rg.end + '/' + total);
          h.set('Content-Length', String(rg.end - rg.start + 1));
          return new Response(mergeStream(f.parts, rg.start, rg.end), { status: 206, headers: h });
        }
        h.set('Content-Length', String(total));
        return new Response(mergeStream(f.parts, 0, total - 1), { status: 200, headers: h });
      }

      /* ---------- 写操作 ---------- */
      if (request.method === 'POST' || request.method === 'DELETE') {
        const ct = request.headers.get('Content-Type') || '';
        const body = ct.indexOf('application/json') >= 0 ? await readBody(request) : {};
        const pass = headerPass || body.password;
        if (!passOk(pass)) return json({ error: '口令不正确' }, 401, cors);

        // 小文件直传（单片）
        if (route === '/put') {
          const key = keyOf(url.searchParams.get('key'));
          if (!key) return json({ error: '缺少 key' }, 400, cors);
          const idx = await buildIndex(env);
          const old = idx.files.get(key);
          if (old) await dropFile(env, old);
          const buf = await request.arrayBuffer();
          const zero = buf.byteLength === 0;
          await uploadAsset(env, partName(key, 1, zero), zero ? PLACEHOLDER : new Uint8Array(buf));
          return json({ ok: true, key }, 200, cors);
        }

        // 新建文件夹
        if (route === '/mkdir') {
          const p = keyOf(body.path);
          if (!p) return json({ error: '缺少文件夹名' }, 400, cors);
          try {
            await uploadAsset(env, dirName(p), PLACEHOLDER);
          } catch (e) {
            if (String(e.message).indexOf('422') < 0) throw e;
          }
          return json({ ok: true, path: p }, 200, cors);
        }

        // 删除（文件 / 文件夹）
        if (route === '/delete') {
          const keys = Array.isArray(body.keys) ? body.keys : body.key ? [body.key] : [];
          if (!keys.length) return json({ error: '缺少 keys' }, 400, cors);
          const idx = await buildIndex(env);
          let removed = 0;
          for (const raw of keys) {
            const k = String(raw || '');
            if (!k) continue;
            const base = k.replace(/\/+$/, '');
            if (!k.endsWith('/') && idx.files.has(k)) {
              const f = idx.files.get(k);
              removed += f.parts.length;
              await dropFile(env, f);
              continue;
            }
            const victims = [];
            idx.files.forEach((f, path) => {
              if (path === base || path.indexOf(base + '/') === 0) victims.push(f);
            });
            for (const f of victims) { removed += f.parts.length; await dropFile(env, f); }
            for (const d of idx.dirAssets) {
              if (d.path === base || d.path.indexOf(base + '/') === 0) {
                try { await delAsset(env, d.id); removed += 1; } catch (e) { /* ignore */ }
              }
            }
          }
          return json({ ok: true, removed }, 200, cors);
        }

        // 文件改名 / 移动
        if (route === '/move') {
          const from = keyOf(body.from);
          const to = keyOf(body.to);
          if (!from || !to || from === to) return json({ error: '路径无效' }, 400, cors);
          const idx = await buildIndex(env);
          const f = idx.files.get(from);
          if (!f) return json({ error: '源文件不存在' }, 404, cors);
          if (idx.files.has(to)) return json({ error: '目标已存在同名文件' }, 409, cors);
          for (const p of f.parts) {
            const resp = await fetch(p.url);
            if (!resp.ok) throw new Error('复制分片失败 HTTP ' + resp.status);
            const buf = new Uint8Array(await resp.arrayBuffer());
            await uploadAsset(env, partName(to, p.n, p.size === 0), buf);
          }
          await dropFile(env, f);
          return json({ ok: true, from, to }, 200, cors);
        }

        // 文件夹改名 / 移动
        if (route === '/mvdir') {
          const from = keyOf(body.from);
          const to = keyOf(body.to);
          if (!from || !to || from === to) return json({ error: '路径无效' }, 400, cors);
          const idx = await buildIndex(env);
          const victims = [];
          idx.files.forEach((f, path) => {
            if (path.indexOf(from + '/') === 0) victims.push({ f, path });
          });
          for (const v of victims) {
            const dst = to + v.path.slice(from.length);
            for (const p of v.f.parts) {
              const resp = await fetch(p.url);
              if (!resp.ok) throw new Error('复制分片失败 HTTP ' + resp.status);
              const buf = new Uint8Array(await resp.arrayBuffer());
              await uploadAsset(env, partName(dst, p.n, p.size === 0), buf);
            }
            await dropFile(env, v.f);
          }
          // 目录占位也一起搬走
          for (const d of idx.dirAssets) {
            if (d.path !== from && d.path.indexOf(from + '/') !== 0) continue;
            const dst = to + d.path.slice(from.length);
            try {
              await uploadAsset(env, dirName(dst), PLACEHOLDER);
              await delAsset(env, d.id);
            } catch (e) { /* 已存在则忽略 */ }
          }
          return json({ ok: true, moved: victims.length }, 200, cors);
        }

        // 分片：初始化（清空同名旧分片）
        if (route === '/mp/init') {
          const key = keyOf(body.key);
          if (!key) return json({ error: '缺少 key' }, 400, cors);
          const idx = await buildIndex(env);
          const old = idx.files.get(key);
          if (old) await dropFile(env, old);
          return json({ key, uploadId: 'r' + Date.now().toString(36), partSize: 8 * 1024 * 1024 }, 200, cors);
        }

        // 分片：完成
        if (route === '/mp/complete') {
          const key = keyOf(body.key);
          const want = (Array.isArray(body.parts) ? body.parts : []).length;
          if (!key || !want) return json({ error: '分片信息不完整' }, 400, cors);
          const idx = await buildIndex(env);
          const f = idx.files.get(key);
          if (!f || f.parts.length < want) {
            return json({ error: '分片不完整（已收 ' + (f ? f.parts.length : 0) + '/' + want + '）' }, 400, cors);
          }
          if (f.parts.length > want) {
            for (const p of f.parts.filter((x) => x.n > want)) {
              try { await delAsset(env, p.id); } catch (e) { /* ignore */ }
            }
          }
          return json({ ok: true, key, size: f.size }, 200, cors);
        }

        // 分片：放弃
        if (route === '/mp/abort') {
          const key = keyOf(body.key);
          const idx = await buildIndex(env);
          const f = idx.files.get(key);
          if (f) await dropFile(env, f);
          return json({ ok: true }, 200, cors);
        }

        return json({ error: '未知接口 ' + route }, 404, cors);
      }

      /* ---------- 分片：上传单片 ---------- */
      if (request.method === 'PUT' && route === '/mp/part') {
        if (!passOk(headerPass)) return json({ error: '口令不正确' }, 401, cors);
        const key = keyOf(url.searchParams.get('key'));
        const n = Number(url.searchParams.get('n'));
        if (!key || !(n > 0)) return json({ error: '缺少分片参数' }, 400, cors);
        const buf = await request.arrayBuffer();
        const zero = buf.byteLength === 0;
        const asset = await uploadAsset(
          env,
          partName(key, n, zero),
          zero ? PLACEHOLDER : new Uint8Array(buf)
        );
        return json({ partNumber: n, etag: String(asset.id) }, 200, cors);
      }

      return json({ error: '未知接口 ' + route }, 404, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, cors);
    }
  },
};
