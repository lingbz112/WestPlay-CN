# WestPlay QQ Music 交接文档

更新日期：2026-10-28  
项目基础：WestPlay 2.1.3（上游提交 `de6e887`）  
QQ Music 非官方集成版本：本地迭代名 `v25`

> 本文中的 `v25` 是本地测试迭代编号，不是上游 WestPlay 的正式版本号。

---

## 1. 当前有效版本

### 当前源码

`C:\Users\Administrator\Documents\Codex\2026-10-27\https-github-com-enes-less-westplay\work\WestPlay-upstream-20261027`

- 当前分支：`qq-music-v25-cover-fix`
- 最新提交：`51c815a Make play pause a global media key`
- 工作树状态：干净
- 当前源码是唯一应继续开发的版本

### 当前测试包

`C:\Users\Administrator\Desktop\WestPlay-QQMusic-Test-v25-hotkeys-r2`

关键文件：

```text
westplay.exe
westplay.dll
install-plugin.cmd
launch-westplay.cmd
ui\
README-TEST.md
SHA256SUMS.txt
```

当前校验值：

```text
419c93ff382e0a315568b8e6db12c1a495c51f64fa21a85efa0fccf840a3eee4  westplay.exe
e04e98c1357908ee079772462a557f604227611a9db82cfc231804dd5708b53b  westplay.dll
```

### 当前 Git 历史

```text
51c815a  Make play pause a global media key
0d19973  Add previous and next track keybinds
10b1a7b  Load every QQ Music home cover on first visit
de0bc8a  Render hidden QQ pages without GPU compositing   ← v25 基线
de6e887  WestPlay 2.1.3                                    ← 上游 main
```

---

## 2. 当前实现概览

QQ Music 没有公开的 CarPlay 式车机接口。当前实现采用：

1. 保留原项目复制出来的 Apple Music 车机 UI。
2. 由 Rust 宿主启动隐藏 WebView2，运行 QQ 音乐网页。
3. 通过注入的 JavaScript 读取 QQ 音乐页面数据、驱动网页播放器。
4. 把网页播放状态转换成 Apple Music UI 使用的播放数据结构。
5. 用 Web Audio / QMA 接管 QQ 音乐音频，并接入车型扬声器和声场。

当前 `v25` 仍使用两个隐藏 WebView2：

- Browse WebView：QQ 首页、雷达、分类歌单、搜索、Library、歌词。
- Player WebView：QQ 播放器页、服务器电台、播放状态和音频。

两个 WebView 共享同一个 QQ Music 用户配置目录和登录态。

---

## 3. 关键源码位置

### Rust 宿主

```text
crates/host/src/qq_music.rs
```

负责：

- 创建 Browse / Player WebView2。
- 转发车机操作到 QQ Music。
- 接收播放状态、页面回答、频谱和播放记录。
- 向播放器转发车型扬声器、驾驶员头部、相机位置、EQ 和频谱设置。
- 处理 QQ 登录窗口和窗口失败恢复。

### QQ 页面适配器

```text
crates/host/src/qq_music.js
```

负责：

- 首页、雷达、分类歌单、搜索、Library 数据读取。
- QQ Webpack API 调用。
- 歌单分页和完整歌曲列表。
- 封面补全、缓存、重试。
- 歌词获取和时间轴解析。
- 向 Player 页投递队列。
- 播放/暂停、上一曲、下一曲、跳转、音量、收藏等控制。
- QMA 音频节点捕获。
- 把 QQ 播放状态转换为车机 UI 的 `Playback` 数据。

### 雷达跨域音频帧

```text
crates/host/src/qq_radio_frame.js
```

负责：

- 在 QQ 电台的跨域子帧中捕获音频/QMA。
- 把音频接入 `cab_sound.js` 的车型声场。
- 把频谱和声场状态回传给 Player 页。

### 车型声场

```text
crates/host/src/cab_sound.js
```

负责：

- 按车型扬声器位置拆分音频。
- HRTF 3D 声场。
- 驾驶员头部跟随。
- 车外声学衰减。
- EQ 和频谱分析。

### 车机 QQ Music UI

```text
ui/src/cabin/apps/qqMusic/
```

这是复制 Apple Music UI 后改名的独立应用，包含：

- 首页
- 雷达
- 分类歌单
- 我的音乐
- 搜索
- Now Playing
- 目前播放列表
- 歌词
- 收藏、音量和播放控制

### 全局快捷键

```text
crates/shared/src/lib.rs
crates/host/src/settings.rs
crates/host/src/lib.rs
crates/plugin/src/keybinds.rs
ui/src/companion/pages/Controls.tsx
ui/src/cabin/apps/keybinds.ts
```

控制流程：

```text
ETS2 前台
→ 插件轮询 GetAsyncKeyState
→ shared bridge 计数
→ Host 读取计数并发送 keybind 消息
→ 车机页找到当前音乐播放器
→ 调用播放/暂停、上一曲或下一曲
```

---

## 4. 已完成功能

### QQ 音乐与登录

- 首页、雷达、分类歌单、搜索、我的音乐。
- QQ 官方扫码登录窗口。
- 不读取或导出 Cookie、Token、账号密码。
- QQ 登录态保存在独立 WebView2 配置目录中。

### Library

- “我喜欢的音乐”使用 QQ API 分页读取，已验证 643 首完整加载。
- “我的已购”直接显示歌曲列表。
- “我创建的歌单”以封面卡片显示。
- 隐藏“我喜欢的音乐”歌单卡片。

### 封面

- 首页第一次打开即补全全部 20 首歌曲封面。
- 热门歌单、专辑、歌曲统一走封面补全。
- Webpack API 就绪等待。
- 批处理失败重试。
- 单曲详情 JSON-LD 回退。
- 封面缓存，切换页面后不会退回默认图。

### 播放与队列

- QQ 普通歌曲、服务器电台和猜你喜欢。
- 播放/暂停、进度、音量、上一曲、下一曲。
- 从歌单播放时加入整张歌单。
- 搜索页单曲播放不会清空现有队列，结束后回到原队列。
- “目前播放列表”显示当前队列。

### 歌词与状态

- 播放位置和歌曲信息同步。
- 歌词时间轴滚动。
- 播放器星星与 QQ“我喜欢”状态同步。
- 首页 Dashboard 显示 QQ Music 播放状态。

### 声场

- 使用项目已有的车型扬声器布局和驾驶员头部位置。
- 普通歌曲捕获 QMA。
- 雷达帧捕获跨域音频并加入声场。
- 车外相机、EQ、频谱均接入。

### 全局快捷键

- 播放/暂停。
- 上一曲。
- 下一曲。
- 可在主窗口“控制 → 按键绑定”中修改。
- 默认使用键盘媒体键。
- 非屏幕键绑定在 ETS2 前台全局生效，车机屏幕关闭时仍可切歌。
- 支持 QQ Music、Apple Music、Spotify、YouTube、YouTube Music。

---

## 5. 本次快捷键实现细节

### Bridge ABI

`crates/shared/src/lib.rs`：

- `KEYBIND_COUNT` 从 3 增加到 5。
- 新槽位：
  - `PreviousTrack = 3`
  - `NextTrack = 4`
- `BRIDGE_VERSION` 从 24 升级到 25。

因此：

- 新主程序必须搭配新版 `westplay.dll`。
- 更新此版后必须重新运行 `install-plugin.cmd`。
- 旧 DLL 不会和新 Host 误共用共享内存。

### 设置迁移

`crates/host/src/settings.rs`：

- `SETTINGS_VERSION` 从 2 升级到 3。
- 新默认：
  - 播放/暂停：媒体播放/暂停键，单独按。
  - 上一曲：媒体上一曲键，单独按。
  - 下一曲：媒体下一曲键，单独按。
- 旧默认 `Alt+2` 的播放/暂停会迁移成媒体播放/暂停键。
- 用户已经自定义过的播放/暂停绑定不会被覆盖。

### “全局”含义

快捷键要求：

- `eurotrucks2.exe` 在前台。
- 不带交互键的绑定不需要打开车机屏幕。
- 正在向车机输入文字时，快捷键暂时不触发，避免误操作。

它不是 Windows 桌面级 `RegisterHotKey`；游戏不在前台时不会抢系统媒体键。

---

## 6. 构建方法

### 本地 Rust 环境

项目使用工作区内的 Rust 工具链：

```powershell
$env:PATH='C:\Users\Administrator\Documents\Codex\2026-10-27\https-github-com-enes-less-westplay\work\rust\cargo\bin;' + $env:PATH
$env:RUSTUP_HOME='C:\Users\Administrator\Documents\Codex\2026-10-27\https-github-com-enes-less-westplay\work\rust\rustup'
$env:CARGO_HOME='C:\Users\Administrator\Documents\Codex\2026-10-27\https-github-com-enes-less-westplay\work\rust\cargo'
$env:CARGO_NET_OFFLINE='true'
```

### UI 测试与构建

```powershell
cd ui
npm test -- --run
npm run build
```

### 插件 DLL

```powershell
cargo build --release -p westplay-plugin --offline
```

输出：

```text
target\release\westplay.dll
```

### 主程序

```powershell
$env:npm_config_cache='C:\Users\Administrator\Documents\Codex\2026-10-27\https-github-com-enes-less-westplay\work\npm-cache'
npx tauri build
```

输出：

```text
target\release\westplay.exe
ui\dist\
```

---

## 7. 测试命令

```powershell
cargo test -p westplay-host --lib settings::tests --offline
cargo test -p westplay-host --lib keybind_messages_include_track_skipping --offline
cargo test -p westplay-shared --lib --offline
cargo check -p westplay-plugin --offline
```

本次交付前已通过：

- 455 个 UI 测试。
- UI TypeScript 与 Vite 生产构建。
- Host 设置、迁移和快捷键消息测试。
- Shared bridge 测试。
- Plugin 编译检查。
- Tauri Release 构建。

已有 QQ 首页 WebView2 回归测试：

```text
the_first_home_answer_has_real_covers
```

结果为：

```text
covers missing 20/20
covers done 20/20
first Home covers missing: []
```

---

## 8. 测试包制作的关键注意事项

### 必须同时更新 `ui` 目录

曾出现过一次严重问题：

- EXE 和 DLL 已更新。
- 测试包里的 `ui` 仍是旧版本。
- 旧车机脚本不认识 `previousTrack`/`nextTrack`。
- 未知 action 被旧逻辑当成 `volumeDown`。
- 所以上一曲/下一曲全部变成音量减。

因此制作测试包时至少同步：

```text
target\release\westplay.exe
target\release\westplay.dll
ui\dist\*  → 包内 ui\*
install-plugin.cmd
```

不要只替换 EXE。

### 插件 DLL 变化时

- 关闭 ETS2。
- 运行 `install-plugin.cmd`。
- 再启动游戏。
- DLL 被游戏占用时无法覆盖。

### Bridge 或 Settings 版本变化时

- `HostBlock` 槽位变化：提升 `BRIDGE_VERSION`。
- 设置含义或默认值变化：提升 `SETTINGS_VERSION` 并在 `migrate` 中处理。

---

## 9. 安装和测试步骤

1. 完全退出 WestPlay。
2. 如果 DLL 有变化，同时退出 ETS2。
3. 在测试包目录运行 `install-plugin.cmd`。
4. 启动 ETS2。
5. 直接运行测试包中的 `westplay.exe`。
6. 打开 QQ Music。
7. 检查：
   - 首页第一次打开封面完整。
   - 播放/暂停。
   - 上一曲、下一曲。
   - 歌词滚动。
   - 声场。
   - 雷达。
8. 打开主窗口“控制 → 按键绑定”：
   - 点击“播放/暂停”重新绑定。
   - 点击“上一曲”重新绑定。
   - 点击“下一曲”重新绑定。
9. 回到游戏，在车机屏幕关闭和打开两种状态下分别测试快捷键。

---

## 10. 日志与故障排查

日志目录：

```text
C:\Users\Administrator\Documents\WestPlay\logs
```

关键文件：

```text
app.log       WestPlay 主程序和 WebView2/QQ Music
plugin.log    ETS2 插件、快捷键、交互键和纹理
textures.txt  纹理诊断
```

快捷键按键记录示例：

```text
keybind PlayPause pressed
keybind PreviousTrack pressed
keybind NextTrack pressed
```

如果日志一直只有 `VolumeDown pressed`，检查：

- 设置文件里的绑定是否被其他动作覆盖。
- 测试包中的 `ui` 是否是本次构建。
- 是否使用了“控制 → 按键绑定”中的正确行。

---

## 11. 已知问题和边界

### NVIDIA 录屏闪烁仍未解决

原始问题：

- 开启 NVIDIA 桌面捕获录制 ETS2 时，画面会在游戏、浏览器/车机和桌面捕获之间交替闪。

已经尝试：

- 调整隐藏 HWND 样式。
- 关闭后台 WebView GPU/合成。
- 单 WebView + iframe（`v27`）。

结果：

- `v27` 仍会闪。
- 单 WebView 还引入播放器、雷达、歌词和声场回归。
- 用户已决定停止该方案。

因此当前 `v25` 的录屏闪烁仍属于未解决问题。不要声称已经修复。

### 不要再直接恢复 v27 为主版本

`qq-single-webview` 分支只保留作研究：

- 分支：`qq-single-webview`
- 提交：`d3bf76c`
- 未完成实验保存在 `stash@{0}`

继续之前必须先重新设计捕获链，而不是只修 iframe 消息。

### QQ Music 网页依赖

- DOM class 和 Webpack 模块编号可能变化。
- 页面更新后需要检查：
  - `module 8`
  - `module 449`
  - `module 467`
  - 封面 JSON-LD
  - Player / player_radio DOM
  - 页面路由

### 登录与隐私

- QQ 登录态在 WebView2 profile 中。
- 不要把 Cookie、Token 或登录 profile 打进发布包。
- `work\chrome-*` 和旧 WebView2 profile 可能包含测试登录数据。

---

## 12. 回退方式

### 回到 v25 基线

```powershell
git switch qq-music-poc-v213
```

对应提交：

```text
de0bc8a
```

### 回到当前快捷键版本

```powershell
git switch qq-music-v25-cover-fix
```

对应提交：

```text
51c815a
```

### 桌面备份

备份目录：

```text
C:\Users\Administrator\Desktop\WestPlay-Backups
```

包含：

- `before-single-webview-v25`：单 WebView 重构前的 v25。
- `single-webview-v27`：废弃的单 WebView 实验。
- `v25-coverfix`：封面修复。
- `v25-hotkeys`：第一版快捷键。
- `v25-hotkeys-r2`：当前快捷键和 UI 同步修复。

每种均包含 `.bundle` 与 `-source.zip`。

---

## 13. 工作区目录说明

正式源码：

```text
...\work\WestPlay-upstream-20261027
```

其他主要目录：

```text
...\work\WestPlay-main              原始解压快照，不是当前版本
...\work\WestPlay.tar.gz            初始源码压缩包
...\work\inspect                    QQ 页面/JS/API 逆向分析
...\work\rust                       本地 Rust 工具链和缓存
...\work\npm-cache                  npm 缓存
...\work\chrome-*                   浏览器测试/登录 profile
...\work\webview2-profile-oldtest   旧 WebView2 测试 profile
```

不要误在 `WestPlay-main` 中开发。

---

## 14. 建议的后续工作

按优先级：

1. 先做一次真实 ETS2 回归，确认 r2 的播放/暂停、上一曲、下一曲和音效。
2. 检查 NVIDIA 录屏闪烁是否存在稳定的独立进程/捕获链方案。
3. 若继续录屏方向，优先设计“QQ 辅助进程 + IPC”，不要再扩大单 WebView iframe 复杂度。
4. 给 QQ API/DOM 适配器增加失败诊断和一个独立离线 fixture 测试。
5. 将多语言中目前使用英文回退的 `Previous track` / `Next track` 逐步本地化。

---

## 15. 交接结论

当前可继续开发和测试的是：

- 源码：`WestPlay-upstream-20261027`
- 分支：`qq-music-v25-cover-fix`
- 提交：`51c815a`
- 测试包：`WestPlay-QQMusic-Test-v25-hotkeys-r2`

主要未解决项只有 NVIDIA 录屏闪烁。QQ Music 的主体功能、封面、歌词、声场、队列和全局媒体快捷键已进入当前 v25 分支。
