# WestPlay QQ Music v25：上一曲/下一曲快捷键

这是封面修复版之上的快捷键版本。

## 新功能

- “控制 → 按键绑定”新增“上一曲”和“下一曲”。
- 默认使用键盘自带的媒体上一曲/下一曲键。
- 不使用屏幕键的绑定会在整个游戏内生效，车机屏幕关闭时也可以切歌。
- 点击绑定后可以按其他按键重新绑定；绑定菜单和其他控制项共用。
- 支持 QQ 音乐、Apple Music、Spotify、YouTube 和 YouTube Music。

## 安装

本版修改了插件与主程序之间的共享桥接，必须同时替换 `westplay.dll`：

1. 完全退出 ETS2 和 WestPlay。
2. 运行 `install-plugin.cmd` 安装新版插件。
3. 直接运行 `westplay.exe`。
4. 打开“控制 → 按键绑定”，按需修改“上一曲/下一曲”。

旧版插件不会被新版主程序误用：桥接版本已从 24 升级到 25。

## 文件校验

```text
cd53e58f935eecfe3325db6d858522bf43d038d52a61bf9c29768167178be927  westplay.exe
e04e98c1357908ee079772462a557f604227611a9db82cfc231804dd5708b53b  westplay.dll
```
