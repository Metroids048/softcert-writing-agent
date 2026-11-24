# 软著写作 Agent

一个在 macOS 本地运行的软件著作权登记材料工作台。上传源代码、软件版本、说明书或申请信息后，工作台先预检材料，再按已确认的版本和交付范围生成或复核申请表底稿、操作说明书与源程序交存件。网页可下载带审核回执的内部审阅包，也支持逐件下载。

## 快速开始

需要 macOS、Node.js 24、Python 3.11 或更新版、Google Chrome 和 Xcode Command Line Tools。扫描件 OCR 使用 macOS Vision。兼容性检查和排版回归使用 LibreOffice；建议在正式处理材料前安装。

在仓库根目录运行：

```sh
export SOFTCERT_RUNTIME="$PWD/.runtime"
mkdir -p "$SOFTCERT_RUNTIME/node/bin"
ln -s "$(command -v node)" "$SOFTCERT_RUNTIME/node/bin/node"
npm install --prefix "$SOFTCERT_RUNTIME/node" jszip@3.10.1 playwright@1.62.1 pdfjs-dist@5.6.205
python3 -m venv "$SOFTCERT_RUNTIME/python"
"$SOFTCERT_RUNTIME/python/bin/python3" -m pip install python-docx==1.2.0 reportlab==4.4.9 pypdf==6.21.4
```

如果 LibreOffice 安装在默认位置，可接到运行时目录：

```sh
mkdir -p "$SOFTCERT_RUNTIME/bin/override"
ln -s /Applications/LibreOffice.app/Contents/MacOS/soffice "$SOFTCERT_RUNTIME/bin/override/soffice"
```

运行 `./app/start.sh`，在浏览器打开 [本地工作台](http://127.0.0.1:8793)。Chrome 安装在其他位置时设置 `SOFTCERT_CHROME`。可通过 `SOFTCERT_PORT` 更改端口，通过 `SOFTCERT_DATA` 更改本地材料和任务状态目录，默认使用仓库下的 `.workbench/`。

## 从预检到取件

1. 上传要核对的 ZIP 源码、PDF 或填写过的申请资料，说明需要整理哪些材料，再点「开始预检」。
2. 按实际发布包确认软件名称、版本和本次范围。对于缺少同版资料、未读完的长件或权属冲突，按页面提示补充依据。
3. 点「自动修订并复验」。核对报告里的文件版本、内容来源及待补项，再下载内部审阅包或逐件取件。替换原件或改变范围后重新复验。

源程序取件使用本次已核对的源码和固定版排版器。后续补件以及对扫描件的文字识别保存在本地工作目录。历史案卷仅在自行配置后可用，`SOFTCERT_CASE_ARCHIVE` 指向案卷根目录，`SOFTCERT_CASE_EVIDENCE` 指向同版运行证据根目录。

## 代码与验证

- `app/server.mjs` 和 `app/index.html` 是本地服务和网页入口。
- `app/filing/` 包含 PDF 读取、排版、实操证据核对与可编辑文档生成。
- `app/verification/` 包含单元测试与网页回归。其中部分历史网页场景需要自备原始档案。
- `.agents/skills/softcert-writing/` 包含 Agent 阶段说明与材料交付规则。

运行单元测试：

```sh
node --test app/verification/*.test.mjs
```

项目代码按根目录 MIT 许可证发布。固定版排版器保留其上游 [MIT 许可证](app/filing/softcert-skill/LICENSE)，Vditor 样例使用的上游样式和语言表保留其 [MIT 许可证](app/filing/web-sources/Vditor-LICENSE)，Noto 字体保留各自的 OFL 许可证。审核包供内部复核，正式提交前请核对申请人、软件版本、源程序范围和补件状态。
