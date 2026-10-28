# WestPlay QQ Music v25：Cabin SoundLab

这是用于判断“实车感究竟缺哪一层”的 A/B 测试包。

## 设置位置

`设置 → 声音 → 驾驶室音色`

四档：

1. `Reference`
   - 保留原扬声器位置、HRTF、车型分频和用户均衡器。
   - 不添加车舱频响、早期反射、压缩或混响。
2. `Cabin EQ`
   - 只添加车舱频响和温和动态压缩。
   - 90 Hz 低频架 +2.4 dB。
   - 220 Hz 低频/低中频 +0.9 dB。
   - 2.8 kHz 存在感频段 -1.2 dB，减少刺耳感。
   - 9 kHz 高频架 -1.1 dB，缓和过亮高音。
   - 1.6:1 温和压缩，让动态更连贯。
3. `Cabin IR`
   - 不添加车舱 EQ 或长混响。
   - 添加约 120–210 ms 的短早期反射，包括玻璃、A 柱、车门、顶棚和后方反射。
   - 主要测试“声音是否在驾驶室内”的空间感。
4. `Full Cabin`
   - Cabin EQ + Cabin IR + 当前可调混响。
   - 混响页面中的大小和强度只在这一档生效。

默认进入 `Full Cabin`。

## 测试建议

同一首歌、同一音量依次切换四档，不要先调 EQ：

- `Reference` 与 `Cabin EQ`：判断是否缺少频响和动态。
- `Cabin EQ` 与 `Cabin IR`：判断是否缺少驾驶室反射。
- `Cabin IR` 与 `Full Cabin`：判断长混响到底有没有帮助。

如果 `Cabin IR` 比 `Full Cabin` 更自然，说明当前长混响应降低或关闭。
如果 `Cabin EQ` 最接近，说明主要缺少的是频响和压缩，而不是空间效果。
如果 `Reference` 仍最好，说明当前车型扬声器模型已经足够，应该继续从音源和原始均衡器入手。

## 研究依据

- I3DA 2021：真实汽车驾驶舱 BRIR、卷积和头部追踪。
- Dirac Spaces：同时建模车辆与目标空间的反射、衰减、时间和相位，不只是混响。
- HARMAN/COMSOL：车内材料吸声、扬声器与头部/躯干/耳道 BRIR 的虚拟调校。
- 真实汽车 DSP 调校顺序：分频、时间/相位、EQ、定位，最后才是 voicing。

## 测试结果

- 457 个 UI 测试通过。
- 201 个非忽略 Host 测试通过。
- 本地 WebView2 440 Hz 音频测试通过：

```text
playing from a: "[0.2538,0.2049,-0.15]"
playing from b: "[0.2535,0.2045,-0.15]"
playing from a: "[0.2543,0.2052,-0.16]"
```

## 文件校验

```text
d4af92fd633c555a2f5f3bd11833fd50e4a3e5f48d0a44e582eeaaab206eab6b  westplay.exe
e04e98c1357908ee079772462a557f604227611a9db82cfc231804dd5708b53b  westplay.dll
```

插件 DLL 与 r2/reverb 版相同；如果已经安装过新版插件，不需要再次安装。
