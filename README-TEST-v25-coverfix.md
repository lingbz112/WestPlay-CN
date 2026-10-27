# WestPlay QQ Music v25 封面修复

这是 v25 的小修复版，重构方式和播放行为不变。

## 修复

- 首页新歌会取 20 首，但原补全逻辑默认只处理前 16 首；最后 4 首现在也会补齐。
- 封面补全会等待 QQ Music 的 webpack API 真正可用后再调用。
- 歌曲批处理失败时会重试，并使用歌曲详情作为回退。
- 热门歌单、专辑和歌曲共用封面缓存，切换页面后不会退回占位图。
- 首页会等首屏内容完整出现后再读取，避免收到半加载的页面。

## 验证

新增 WebView2 首屏测试，结果：

```text
covers missing 20/20
covers done 20/20
first Home covers missing: []
```

插件 DLL 未变化，无需重新安装插件。

## 文件校验

```text
cdbc7b06c9bf081537d4cde71d4d77c6e075b4ad34d7da79bb25441952da3f6d  westplay.exe
774484510c81f39b7df2fa02039ddbf2d4f86c3d20b4d8df6e7944b6ecd5993d  westplay.dll
```
