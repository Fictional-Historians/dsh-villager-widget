# 改动说明（相对上游 dsh-whale-widget 0.4.2）

本项目是 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）的社区分支。
改动分两部分：**前端行为**（`assets/whale-widget.js`）与**运行时素材生成**（`lib/villager-mc.mjs` + `lib/index.js`）。

> 这个插件没有构建步骤：`assets/whale-widget.js` 就是最终产物。

## 1. MC 村民角色（运行时就地生成）

新增两个角色：

| 角色 id | 名称 | 构成（全部来自用户本机 MC 客户端） |
|---|---|---|
| `villager` | 绿衣村民 | `villager.png` + `type/plains.png` + `profession/nitwit.png` |
| `swamp_librarian` | 沼泽图书管理员 | `villager.png` + `type/swamp.png` + `profession/librarian.png` |

**发布包里不含任何 Mojang 素材**。插件启动 2.5 秒后扫描本机 Minecraft：

1. 找客户端目录：`DSH_MC_DIR` 环境变量 → `%APPDATA%\.minecraft` → `~/.minecraft` → `C:\MCjava\.minecraft`；
2. 找版本 jar：`versions/<ver>/<ver>.jar`，优先正式版；
3. 用自带的最小 ZIP 读取器取出贴图，`zlib` 解 PNG（支持调色板 PNG —— MC 的贴图正是 8 位索引色）；
4. 叠加三层贴图后，在 Node 里用纯数组光栅化渲染成 PNG（无 canvas 依赖）；
5. 音效按 `assets/indexes/*.json` 的散列直接拼路径，从 `assets/objects` 拷贝。

生成结果写入 `$DSH_HOME/whale-roles/`（角色图）与 `$DSH_HOME/whale-mc-sounds/`（音效），
并把两个角色登记进 `roles.json`。实测在你本机的一次生成耗时约 **140ms**。

模型数字来自 `net/minecraft/client/model/npc/VillagerModel.createBodyModel()`：
头 8×10×8、鼻 2×4×2、躯干 8×12×6、长袍 8×20×6（膨胀 0.5）、双臂 4×8×4 ×2 + 交叉前臂 8×4×4
（整组绕 X 轴 −0.75 rad）、腿 4×12×4 ×2、帽子层 8×10×8（膨胀 0.51，texOffs(32,0)）。

**没装 Minecraft 的机器**：不生成角色、音效路由返回 404，挂件其余功能完全不受影响。

## 2. 受击红闪

点击角色时叠一层同位置的红色副本。红色不是 CSS 滤镜硬调出来的（`sepia+saturate` 会把青色
压成黄色），而是注入一个 SVG `feColorMatrix`：

```
R' = 1.5 × (0.213R + 0.715G + 0.072B)   G' = B' = 0   A' = A
```

即“亮度 → 红”，和 Minecraft 里生物受击的着色同构：只有角色自身像素变色，明暗层次保留，
透明像素不受影响，周围的空气不会跟着闪。闪烁序列由 JS 逐帧写 opacity
（0 → 1 → 0 → 0.95 → 0，260ms 两下）。

## 3. 点击音效序列

| 第几下 | 音效 | 原版资源 |
|---|---|---|
| 1 | 打招呼 | `mob/villager/idle1.ogg` |
| 2–5 | 受击 | `mob/villager/hit1.ogg` |
| 6 | 阵亡 | `mob/villager/death.ogg` |
| 7 | 回到打招呼，循环 | — |

音效**不内嵌**，前端向 `/dsh-whale/mc-sound?id=ambient|hit|death` 取；服务端从本机 MC 拷进
`whale-mc-sounds/` 后按 `audio/ogg` 下发（Chromium 原生解 Ogg Vorbis，不需要转码）。

**+1 Hz** 用 `HTMLAudioElement.playbackRate` 实现 —— 它同时改变音高与速度，等价于离线重采样：

| 素材 | 原基频 | 目标 | playbackRate |
|---|---|---|---|
| ambient | 110.25 Hz | 111.25 Hz | 1.009070 |
| hit | 182.23 Hz | 183.23 Hz | 1.005488 |
| death | 270.55 Hz | 271.55 Hz | 1.003696 |

## 4. 峰谷自动换角色

`autoRoleSync()` 复用挂件自己的峰谷判定 `bubbleIsPeakNow()`（服务端 `isPeak` 优先，
未就绪时按北京时间规则兜底）：

- 高峰 → `villager`（绿衣村民）
- 空闲 → `swamp_librarian`（沼泽图书管理员）

角色列表载入后立即校正一次，之后每 30 秒检查。为避免覆盖用户手选的其他角色，
**只有当当前角色是这两个之一时才会自动切换**。

## 5. 角色列表可点击

修复了角色列表行不响应点击的问题（`pointer-events:auto` + pointerdown/pointerup/click
三重绑定，并排除行内按钮），使切换角色在部分环境下不会失灵。

## 6. 授权

- `lib/`、`cordis.patch.yml`、`package.json`、文档 —— **MIT**（沿用上游 `LICENSE`，保留原版权声明）。
- `assets/` 里上游自带的图片/动图/音效 —— 不适用 MIT，随包 as-is 分发，详见 `PROVENANCE.md`。
- **本分支不打包任何 Mojang 素材**：村民贴图与音效一律在用户机器上现场生成（见第 1 节），
  仓库里只有生成代码。
