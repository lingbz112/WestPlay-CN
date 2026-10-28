# WestPlay Unofficial Enhanced Fork

> [!WARNING]
> **Known issue: screen recordings flicker when NVIDIA App desktop capture is enabled.**
>
> NVIDIA App desktop capture also includes the WebView2/Chromium composition surfaces WestPlay uses to render the truck screen. As a result, recordings alternate between the game, browser and truck-screen images.
>
> **Workaround: disable desktop capture in NVIDIA App before recording.**
>
> This issue cannot currently be fixed reliably on the WestPlay side.

This repository is a personal maintenance fork of [enes-less/WestPlay](https://github.com/enes-less/WestPlay), based on version `2.1.4`. It focuses on Chinese music-service integrations, Chinese localization and cabin audio enhancements.

Packages, release notes and known issues are published only in this repository's [Releases](https://github.com/lingbz112/WestPlay/releases). This README is limited to version information and essential notices.

## Differences from upstream

- Integrates Chinese online music services, currently including QQ Music, using the existing in-vehicle music-app interaction model.
- Adds Chinese localization and adjustments required by Chinese music services.
- Enhances cabin audio with cabin EQ/IR, independent reverb, fixed-direction early reflections and directionless bass management.
- Adds global play/pause, previous-track and next-track keyboard shortcuts.

Additional Chinese music platforms will continue to be merged into the same branch. No separate long-lived branch will be created for each app.

## Versioning

- Upstream version: `WestPlay 2.1.4`
- Upstream commit: `92c3d55`
- Long-lived fork branch: `main`
- Fork release tag format: `v<upstream-version>-cn.<revision>`

For example, the first and second fork releases based on the same upstream version use `v2.1.4-cn.1` and `v2.1.4-cn.2`. After the upstream version advances to 2.1.5, fork revisions restart at `v2.1.5-cn.1`.

## License and legal information

This project follows the upstream WestPlay license, the **GNU General Public License v3.0 or later (GPL-3.0-or-later)**. Copyright in the original project remains with its original author and other contributors. Changes in this fork are also distributed under GPL-3.0-or-later. See [`LICENSE`](LICENSE) for the full terms and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for third-party components and notices.

This is an unofficial community fork. It is not affiliated with, authorized by, partnered with, or endorsed by Tencent, QQ Music, or their affiliates. The QQ Music name, icon, trademarks, service marks and related assets remain the property of their respective owners. Their inclusion in this repository identifies the compatible service only and does not grant a license under the GPL.

QQ Music accounts, content and usage are subject to QQ Music's terms of service and applicable law. This project does not provide music content, bypass payment, copyright protection or access controls, or grant any rights to third-party content. The web player is not a stable public integration interface, and service changes may break related functionality.

User login information and cookies remain in the local WebView2 profile. This fork does not upload them to a WestPlay-operated server. The software is provided "as is", without express or implied warranty. The maintainer is not liable for losses resulting from use of this software.
