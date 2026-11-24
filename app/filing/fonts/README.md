# 源码册 PDF 字体补充

Noto Emoji 仅为源码 PDF 中默认字体未覆盖的字符提供黑白字形。字体随项目保留，构建和运行时不联网。上游文件在 [Google Fonts 固定提交目录](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoemoji)。本地原样保存为 `NotoEmoji.ttf`，SHA-256 为 `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`，许可证为 [SIL Open Font License 1.1](OFL.txt)。

Noto Sans Symbols 2 在原有字体之后补充盲文等源码字符。上游为 [Google Fonts 固定提交目录](https://github.com/google/fonts/tree/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/notosanssymbols2)，本地文件为 `NotoSansSymbols2-Regular.ttf`，SHA-256 为 `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21`，许可证为 [SIL Open Font License 1.1](NotoSansSymbols2-OFL.txt)。两份字体均纳入启动策略指纹，PDF 继续逐页回读校验原字符。

若前述字体仍无所需字形，源码册使用运行时已有的系统 Arial Unicode 补充。工作台记录其实际文件 SHA-256 并随候选绑定；字体依赖由当前宿主提供。
