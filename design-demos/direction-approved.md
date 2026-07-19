# Design Direction — Approved

**Date:** 2026-07-18
**Chosen:** Direction A · Paper & Ink (纸墨沉浸)

## 展示的三个方向(真实视觉,阅读页 mockup)
- `A-paper-ink.html` — 暖色纸墨 + 衬线标题 + 赭石/松绿点缀,高端电子书阅读器气质 ← **用户选定**
- `B-focused-study.html` — 冷静蓝灰 + 现代 SaaS 工具感 + 底部状态栏
- `C-vibrant-learning.html` — 靛蓝+珊瑚 + 圆润卡片 + 进度环 + 连续天数

截图:`scratchpad/demo-{A,B,C}-*.png`

## 用户选择原话
选定 "A · Paper & Ink 纸墨沉浸"(暖色纸感背景 + 衬线标题 + 赭石强调;安静/高级/护眼,适合长时间沉浸阅读)。

## 设计 token(应用到整个 React app)
- 背景 `--bg: #ded7c6` / 纸面 `--paper: #f4f0e5` / 卡片 `--panel: #fbf9f3`
- 墨 `--ink: #2b2620` / 弱墨 `--ink-soft: #6b6152` / 线 `--line: #e2dccb`
- 赭石强调 `--accent: #7c5b3b` / 松绿次强调 `--accent-2: #3f6b52` / 生词标记 `--hi: #e9c46a`
- 衬线:标题/品牌/词条/tab 用 `Iowan Old Style, Palatino, Georgia, Songti SC, serif`

## 同时执行
所有 UI 文案(标签/按钮/占位/提示)从中文改为英文;学习内容里的中文释义保留(那是学习材料本身)。
