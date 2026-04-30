# Mikro Kosmos

一个面向手机浏览器的实验性 WebApp：使用摄像头输入分析画面亮度、运动和视觉重心，并通过 Web Audio 生成实时声场反馈。

## 功能

- 调用后置摄像头作为实时视觉输入。
- 在本地 canvas 中分析画面亮度、运动强度和运动/高亮区域重心。
- 将视觉重心映射为左右声像，将亮度映射为音高，将运动映射为音量与脉冲感。
- 提供移动端优先的可视化 HUD，展示声像、深度、亮度和运动强度。
- 附带 Web App Manifest，可作为 PWA 基础安装到手机主屏幕。

## 本地运行

```bash
npm start
```

然后访问 `http://localhost:4173`。手机摄像头权限通常要求 HTTPS 或 localhost；如果用真机访问开发电脑，请使用支持 HTTPS 的本地代理/隧道。

## GitHub Pages 预览

项目已经配置为 GitHub Pages 兼容的纯静态站点。合并到 `main` 后，GitHub Actions 会把仓库根目录发布到 Pages。

1. 在 GitHub 仓库的 **Settings → Pages** 中，将 Source 设为 **GitHub Actions**。
2. 合并或手动运行 `Deploy static app to GitHub Pages` workflow。
3. 打开仓库对应的 Pages 地址，例如 `https://<user>.github.io/mikro-kosmos/`。

GitHub Pages 使用 HTTPS，手机浏览器可以直接申请摄像头权限；首次启动仍需用户点击按钮授权音频播放。

## 检查

```bash
npm run check
```

## 使用方式

1. 用手机浏览器打开应用。
2. 点击“启动声场反馈”，允许摄像头权限。
3. 缓慢移动手机或让画面目标移动，感受声音在左右声像、音高和强度上的变化。

所有分析和音频合成都在浏览器本地完成，不上传摄像头画面。