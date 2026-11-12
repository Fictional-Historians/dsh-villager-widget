// ============================================================================
// villager-mc.mjs —— 从用户本机的 Minecraft 客户端现场生成村民素材
// ----------------------------------------------------------------------------
// 发布包里**不含任何 Mojang 素材**：贴图与音效都在用户机器上读取、现场生成。
//   · 贴图：<mc>/versions/<ver>/<ver>.jar → assets/minecraft/textures/entity/villager/*
//   · 音效：<mc>/assets/indexes/<n>.json 索引 → assets/objects/<h2>/<hash>
// 渲染是在 Node 里用纯数组做的（zlib 解/压 PNG + 手写光栅化），不依赖 canvas。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

// ---------------------------------------------------------------- ZIP 读取
function u16(b, o) { return b[o] | (b[o + 1] << 8) }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }

/** 极简 ZIP 读取：只做「按名字取一项」，够读客户端 jar 里的贴图与 sounds.json。 */
export function zipEntries(buf) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
      if (u32(buf, i) === 0x06054b50) return i
    }
    return -1
  })()
  if (eocd < 0) return new Map()
  const count = u16(buf, eocd + 10)
  let p = u32(buf, eocd + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) break
    const method = u16(buf, p + 10)
    const csize = u32(buf, p + 20)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOff = u32(buf, p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    out.set(name, { method, csize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export function zipRead(buf, index, name) {
  const e = index.get(name)
  if (!e) return null
  const p = e.localOff
  if (u32(buf, p) !== 0x04034b50) return null
  const nameLen = u16(buf, p + 26)
  const extraLen = u16(buf, p + 28)
  const dataOff = p + 30 + nameLen + extraLen
  const raw = buf.subarray(dataOff, dataOff + e.csize)
  if (e.method === 0) return raw
  if (e.method === 8) {
    try { return zlib.inflateRawSync(raw) } catch (err) { return null }
  }
  return null
}

// ---------------------------------------------------------------- PNG 读写
// ---------------------------------------------------------------- PNG 读写
export function pngDecode(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  let p = 8, w = 0, h = 0, depth = 8, color = 6
  let palette = null, trns = null
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      trns = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    p += 12 + len
  }
  if (!w || !h) return null
  // 通道数：0=灰度 2=RGB 3=索引 4=灰度+alpha 6=RGBA
  const channels = color === 6 ? 4 : color === 2 ? 3 : (color === 4 || color === 0) ? 1 : color === 3 ? 1 : 0
  if (!channels || !idat.length) return null
  if (color !== 3 && depth !== 8) return null
  if (color === 3 && !palette) return null

  const bitsPP = channels * depth
  const stride = Math.ceil((w * bitsPP) / 8)
  const bpp = Math.max(1, Math.ceil(bitsPP / 8))
  let raw
  try { raw = zlib.inflateSync(Buffer.concat(idat)) } catch (err) { return null }
  const out = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride)
  let off = 0
  for (let y = 0; y < h; y++) {
    if (off >= raw.length) break
    const ft = raw[off++]
    const line = Buffer.from(raw.subarray(off, off + stride))
    off += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      line[x] = v & 255
    }
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4
      if (color === 3) {
        let idx
        if (depth === 8) idx = line[x]
        else {
          const bitPos = x * depth
          const byte = line[bitPos >> 3]
          const shift = 8 - depth - (bitPos & 7)
          idx = (byte >> shift) & ((1 << depth) - 1)
        }
        const pi = idx * 3
        out[d] = palette[pi] || 0
        out[d + 1] = palette[pi + 1] || 0
        out[d + 2] = palette[pi + 2] || 0
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255
      } else if (color === 6) {
        const s = x * 4
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]
      } else if (color === 2) {
        const s = x * 3
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255
      } else {
        const g = line[x]
        out[d] = g; out[d + 1] = g; out[d + 2] = g; out[d + 3] = 255
      }
    }
    prev = line
  }
  return { w, h, data: out }
}

export function pngEncode(data, w, h) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    data.copy ? data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : raw.set(data.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }
  const chunks = []
  const chunk = (type, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    chunks.push(len, body, crc)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  chunk('IHDR', ihdr)
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 }))
  chunk('IEND', Buffer.alloc(0))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return c ^ -1
}

// ---------------------------------------------------------------- 找 Minecraft
function existingDirs(list) {
  const out = []
  for (const p of list) {
    try { if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) out.push(p) } catch (err) {}
  }
  return out
}

export function findMinecraft(extraDirs) {
  const home = os.homedir()
  const cands = [
    ...(extraDirs || []),
    process.env.DSH_MC_DIR,
    path.join(process.env.APPDATA || '', '.minecraft'),
    path.join(home, '.minecraft'),
    path.join(home, 'AppData', 'Roaming', '.minecraft'),
    path.join(home, 'Documents', '.minecraft'),
    'C:\\MCjava\\.minecraft'.replace(/\\/g, path.sep),
    'D:\\.minecraft'.replace(/\\/g, path.sep),
  ]
  for (const mc of existingDirs(cands)) {
    const versions = path.join(mc, 'versions')
    if (!fs.existsSync(versions)) continue
    let dirs = []
    try { dirs = fs.readdirSync(versions) } catch (err) { continue }
    // 优先正式版（版本号形如 1.21 / 26.3），其次快照
    dirs = dirs.filter((d) => fs.existsSync(path.join(versions, d)))
    dirs.sort((a, b) => {
      const rel = /^\d/.test(a) ? 0 : 1
      const rbl = /^\d/.test(b) ? 0 : 1
      if (rel !== rbl) return rel - rbl
      return b.localeCompare(a, undefined, { numeric: true })
    })
    for (const d of dirs) {
      const jar = path.join(versions, d, d + '.jar')
      if (!fs.existsSync(jar)) continue
      return { mcDir: mc, version: d, jarPath: jar, assetsDir: path.join(mc, 'assets') }
    }
  }
  return null
}

// ---------------------------------------------------------------- 音效索引
function loadSoundIndex(assetsDir) {
  const dir = path.join(assetsDir, 'indexes')
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch (err) { return null }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (let i = names.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, names[i]), 'utf8'))
      if (j && j.objects) return j.objects
    } catch (err) {}
  }
  return null
}

function objectPath(assetsDir, hash) {
  return path.join(assetsDir, 'objects', hash.slice(0, 2), hash)
}

/** 从 sounds.json + 索引里取出一条事件对应的第一个 ogg。 */
function readSoundEvent(assetsDir, objects, soundsJson, event) {
  try {
    const ev = soundsJson[event]
    if (!ev) return null
    const list = ev.sounds || []
    for (const s of list) {
      const name = typeof s === 'string' ? s : s.name
      if (!name) continue
      const key = 'minecraft/sounds/' + name.replace(/^minecraft:/, '') + '.ogg'
      const e = objects[key]
      if (!e) continue
      const p = objectPath(assetsDir, e.hash)
      if (fs.existsSync(p)) return { path: p, hash: e.hash }
    }
  } catch (err) {}
  return null
}

// ---------------------------------------------------------------- 贴图合成
const ENTRY = 'assets/minecraft/textures/entity/villager/'

function composeLayers(zipBuf, index, layers) {
  const base = pngDecode(zipRead(zipBuf, index, ENTRY + 'villager.png') || Buffer.alloc(0))
  if (!base) return null
  const W = base.w, H = base.h
  const out = Buffer.from(base.data)
  for (const name of layers) {
    const b = zipRead(zipBuf, index, ENTRY + name)
    if (!b) continue
    const ov = pngDecode(b)
    if (!ov || ov.w !== W || ov.h !== H) continue
    for (let i = 0; i < W * H; i++) {
      const a = ov.data[i * 4 + 3] / 255
      if (a <= 0) continue
      for (let k = 0; k < 3; k++) {
        out[i * 4 + k] = Math.round(ov.data[i * 4 + k] * a + out[i * 4 + k] * (1 - a))
      }
      out[i * 4 + 3] = 255
    }
  }
  // 帽子层里有 4 个 #BFECFB 的「眼睛高光」像素，比脸贴图的眼睛低一行，
  // 叠上去会在脸颊多出一条浅蓝横线；抠掉它们，让脸自己的眼睛透出来。
  for (let y = 0; y < 18; y++) {
    for (let x = 32; x < 64; x++) {
      const i = (y * W + x) * 4
      if (out[i] === 191 && out[i + 1] === 236 && out[i + 2] === 251) out[i + 3] = 0
    }
  }
  return { w: W, h: H, data: out }
}

// ---------------------------------------------------------------- 模型
// 数字来自 net/minecraft/client/model/npc/VillagerModel.createBodyModel()
const X_SCALE = 1.28
const Y_SCALE = 0.45
const ARMS_PIVOT = [0, 21, -1]
const ARMS_ROT = 0.75
const YAW = 28 * Math.PI / 180
const PITCH = 6 * Math.PI / 180

function armsXf(p) {
  const [x, y, z] = p
  const dy = y - ARMS_PIVOT[1], dz = z - ARMS_PIVOT[2]
  const c = Math.cos(ARMS_ROT), s = Math.sin(ARMS_ROT)
  return [x, ARMS_PIVOT[1] + dy * c - dz * s, ARMS_PIVOT[2] + dy * s + dz * c]
}

const BOXES = [
  ['head', [-4, 24, -4, 4, 34, 4], [0, 0], 8, 10, 8, false, null],
  ['hat', [-4.51, 23.49, -4.51, 4.51, 34.51, 4.51], [32, 0], 8, 10, 8, false, null],
  ['nose', [-1, 23, -6, 1, 27, -4], [24, 0], 2, 4, 2, false, null],
  ['body', [-4, 12, -3, 4, 24, 3], [16, 20], 8, 12, 6, false, null],
  ['jacket', [-4.5, 4, -3.5, 4.5, 24, 3.5], [0, 38], 8, 20, 6, false, null],
  ['arm_r', [-8, 15, -3, -4, 23, 1], [44, 22], 4, 8, 4, false, armsXf],
  ['arm_l', [4, 15, -3, 8, 23, 1], [44, 22], 4, 8, 4, true, armsXf],
  ['forearms', [-4, 17, -3, 4, 21, 1], [40, 38], 8, 4, 4, false, armsXf],
  ['leg_r', [-4, 0, -2, 0, 12, 2], [0, 22], 4, 12, 4, false, null],
  ['leg_l', [0, 0, -2, 4, 12, 2], [0, 22], 4, 12, 4, true, null],
]

function facesOf(box, uv, w, h, d, mirror, xf) {
  const [x0, y0, z0, x1, y1, z1] = box
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
  const [u, v] = uv
  const F = []
  const add = (rect, fn, n) => {
    const [ru, rv, rw, rh] = rect
    let s = [0, 1, 1, 0], t = [0, 0, 1, 1]
    if (mirror) s = s.map((k) => 1 - k)
    let pts = []
    let uvs = []
    for (let k = 0; k < 4; k++) {
      let p = fn(s[k], t[k])
      if (xf) p = xf(p)
      pts.push(p)
      uvs.push([ru + s[k] * rw, rv + t[k] * rh])
    }
    F.push({ pts, uvs, n })
  }
  add([u + d, v + d, w, h], (s, t) => [x1 - s * dx, y1 - t * dy, z0], [0, 0, -1])
  add([u + d + w + d, v + d, w, h], (s, t) => [x0 + s * dx, y1 - t * dy, z1], [0, 0, 1])
  add([u, v + d, d, h], (s, t) => [x1, y1 - t * dy, z1 - s * dz], [1, 0, 0])
  add([u + d + w, v + d, d, h], (s, t) => [x0, y1 - t * dy, z0 + s * dz], [-1, 0, 0])
  add([u + d, v, w, d], (s, t) => [x1 - s * dx, y1, z0 + t * dz], [0, 1, 0])
  add([u + d + w, v, w, d], (s, t) => [x1 - s * dx, y0, z1 - t * dz], [0, -1, 0])
  return F
}

export function renderVillager(sheet, outH = 300, ss = 3) {
  const faces = []
  for (const [, box, uv, w, h, d, mir, xf] of BOXES) {
    for (const f of facesOf(box, uv, w, h, d, mir, xf)) {
      f.pts = f.pts.map(([x, y, z]) => [x * X_SCALE, y * Y_SCALE, z])
      faces.push(f)
    }
  }
  const ca = Math.cos(YAW), sa = Math.sin(YAW)
  const cb = Math.cos(PITCH), sb = Math.sin(PITCH)
  const proj = (p) => {
    const X0 = p[0] * ca + p[2] * sa
    const Z0 = -p[0] * sa + p[2] * ca
    return [X0, p[1] * cb - Z0 * sb, -(p[1] * sb + Z0 * cb)]
  }
  const pts2 = []
  for (const f of faces) {
    f.p2 = f.pts.map(proj)
    pts2.push(...f.p2)
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of pts2) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  const spanX = maxX - minX, spanY = maxY - minY
  const scale = (outH / spanY) * ss
  const pad = 2 * ss
  const W = Math.ceil(spanX * scale + 2 * pad)
  const H = Math.ceil(spanY * scale + 2 * pad)
  const BW = W, BH = H
  const color = new Uint8Array(BW * BH * 3)
  const alpha = new Uint8Array(BW * BH)
  const zbuf = new Float32Array(BW * BH).fill(-1e9)

  for (const f of faces) {
    const X = f.p2.map((p) => (p[0] - minX) * scale + pad)
    const Y = f.p2.map((p) => (maxY - p[1]) * scale + pad)
    const D = f.p2.map((p) => p[2])
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      const [a, b, c] = tri
      const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[c], y2 = Y[c]
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (Math.abs(area) < 1e-9) continue
      const ix0 = Math.max(Math.floor(Math.min(x0, x1, x2)), 0)
      const ix1 = Math.min(Math.ceil(Math.max(x0, x1, x2)), BW - 1)
      const iy0 = Math.max(Math.floor(Math.min(y0, y1, y2)), 0)
      const iy1 = Math.min(Math.ceil(Math.max(y0, y1, y2)), BH - 1)
      if (ix1 < ix0 || iy1 < iy0) continue
      for (let py = iy0; py <= iy1; py++) {
        const gy = py + 0.5
        for (let px = ix0; px <= ix1; px++) {
          const gx = px + 0.5
          const d0 = ((x1 - gx) * (y2 - gy) - (x2 - gx) * (y1 - gy)) / area
          const d1 = ((x2 - gx) * (y0 - gy) - (x0 - gx) * (y2 - gy)) / area
          const d2 = 1 - d0 - d1
          if (d0 < -1e-6 || d1 < -1e-6 || d2 < -1e-6) continue
          const depth = d0 * D[a] + d1 * D[b] + d2 * D[c]
          const idx = py * BW + px
          if (depth <= zbuf[idx]) continue
          const uu = d0 * f.uvs[a][0] + d1 * f.uvs[b][0] + d2 * f.uvs[c][0]
          const vv = d0 * f.uvs[a][1] + d1 * f.uvs[b][1] + d2 * f.uvs[c][1]
          const tx = Math.min(63, Math.max(0, Math.floor(uu)))
          const ty = Math.min(63, Math.max(0, Math.floor(vv)))
          const ti = (ty * 64 + tx) * 4
          if (sheet.data[ti + 3] <= 127) continue
          zbuf[idx] = depth
          color[idx * 3] = sheet.data[ti]
          color[idx * 3 + 1] = sheet.data[ti + 1]
          color[idx * 3 + 2] = sheet.data[ti + 2]
          alpha[idx] = 255
        }
      }
    }
  }

  // 降采样到目标高度（ss 倍盒式平均）
  const dW = Math.max(1, Math.round(BW / ss))
  const dH = Math.max(1, Math.round(BH / ss))
  const out = Buffer.alloc(dW * dH * 4)
  for (let y = 0; y < dH; y++) {
    for (let x = 0; x < dW; x++) {
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x * ss + sx, py = y * ss + sy
          if (px >= BW || py >= BH) continue
          const i = py * BW + px
          if (!alpha[i]) continue
          r += color[i * 3]; g += color[i * 3 + 1]; b += color[i * 3 + 2]; n++
        }
      }
      const o = (y * dW + x) * 4
      if (n) {
        out[o] = Math.round(r / n)
        out[o + 1] = Math.round(g / n)
        out[o + 2] = Math.round(b / n)
        out[o + 3] = Math.min(255, Math.round((n / (ss * ss)) * 255))
      }
    }
  }
  // 裁掉透明边
  let bx0 = dW, by0 = dH, bx1 = -1, by1 = -1
  for (let y = 0; y < dH; y++) {
    for (let x = 0; x < dW; x++) {
      if (out[(y * dW + x) * 4 + 3]) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
  }
  if (bx1 < 0) return { w: dW, h: dH, data: out }
  const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1
  const cropped = Buffer.alloc(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    out.copy(cropped, y * cw * 4, ((y + by0) * dW + bx0) * 4, ((y + by0) * dW + bx0 + cw) * 4)
  }
  return { w: cw, h: ch, data: cropped }
}

// ---------------------------------------------------------------- 对外入口
export const VILLAGER_ROLES = [
  { id: 'villager', name: '绿衣村民', layers: ['type/plains.png', 'profession/nitwit.png'] },
  { id: 'swamp_librarian', name: '沼泽图书管理员', layers: ['type/swamp.png', 'profession/librarian.png'] },
]

export const MC_SOUND_IDS = {
  ambient: 'entity.villager.ambient',
  hit: 'entity.villager.hurt',
  death: 'entity.villager.death',
}

// 原版声音事件 → 资源路径（按优先级，取第一个存在的）
export const MC_SOUND_PATHS = {
  ambient: [
    'minecraft/sounds/mob/villager/idle1.ogg',
    'minecraft/sounds/mob/villager/idle2.ogg',
    'minecraft/sounds/mob/villager/idle3.ogg',
  ],
  hit: [
    'minecraft/sounds/mob/villager/hit1.ogg',
    'minecraft/sounds/mob/villager/hit2.ogg',
    'minecraft/sounds/mob/villager/hit3.ogg',
  ],
  death: [
    'minecraft/sounds/mob/villager/death.ogg',
  ],
}

function firstObject(assetsDir, objects, paths) {
  for (const key of paths) {
    const e = objects[key]
    if (!e) continue
    const p = objectPath(assetsDir, e.hash)
    try { if (fs.existsSync(p)) return p } catch (err) {}
  }
  return null
}

/**
 * 现场生成：角色图（PNG）+ 音效（ogg 原样拷贝）。
 * @returns {{ok:boolean, reason?:string, mc?:object, roles?:string[], sounds?:string[]}}
 */
export function ensureMcAssets(opts) {
  const { roleDir, soundDir, extraMcDirs, force } = opts || {}
  const report = { ok: false, roles: [], sounds: [] }
  const mc = findMinecraft(extraMcDirs)
  if (!mc) { report.reason = 'no-minecraft'; return report }
  report.mc = mc

  let jar
  try { jar = fs.readFileSync(mc.jarPath) } catch (err) {
    report.reason = 'jar-unreadable'
    return report
  }
  const index = zipEntries(jar)

  // 角色图
  try {
    fs.mkdirSync(roleDir, { recursive: true })
    for (const role of VILLAGER_ROLES) {
      const dst = path.join(roleDir, role.id + '.png')
      if (!force && fs.existsSync(dst) && fs.statSync(dst).size > 1024) { report.roles.push(role.id); continue }
      const sheet = composeLayers(jar, index, role.layers)
      if (!sheet) continue
      const img = renderVillager(sheet, 300, 3)
      fs.writeFileSync(dst, pngEncode(Buffer.from(img.data), img.w, img.h))
      report.roles.push(role.id)
    }
  } catch (err) {
    report.reason = 'render-failed:' + (err && err.message)
  }

  // 音效：新版客户端 jar 里已经没有 sounds.json（声音事件改成数据驱动了），
  // 所以直接按原版资源路径到 assets 索引里找，找不到再试同组的下一个。
  try {
    const objects = loadSoundIndex(mc.assetsDir)
    if (objects) {
      fs.mkdirSync(soundDir, { recursive: true })
      for (const [id, paths] of Object.entries(MC_SOUND_PATHS)) {
        const dst = path.join(soundDir, id + '.ogg')
        if (!force && fs.existsSync(dst) && fs.statSync(dst).size > 512) { report.sounds.push(id); continue }
        const s = firstObject(mc.assetsDir, objects, paths)
        if (!s) continue
        fs.copyFileSync(s, dst)
        report.sounds.push(id)
      }
    } else {
      report.reason = report.reason || 'no-assets-index'
    }
  } catch (err) {
    report.reason = report.reason || ('sound-failed:' + (err && err.message))
  }

  report.ok = report.roles.length === VILLAGER_ROLES.length
  return report
}
