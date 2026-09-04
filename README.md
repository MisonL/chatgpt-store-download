# ChatGPT Store Download

用于查询并校验微软官方 ChatGPT Work/Codex Windows MSIX 临时下载直链的 Codex Skill。

## 功能

- 通过 Microsoft StoreEdge 和 FE3 查询最新包。
- 支持 `x64`、`arm64` 和 `both` 架构。
- 校验产品身份、包版本、更新关联、文件大小、SHA-1、SHA-256 和 CDN 响应。
- 支持 macOS、Linux、Windows 和 WSL 上的 Node.js 14+。
- 输出文本或 JSON，并提供离线回归自测。

## 一键安装

需要已安装 Git。以下命令会安装或更新到 `${CODEX_HOME:-$HOME/.codex}/skills/chatgpt-store-download`，不会下载 ChatGPT MSIX 文件。

macOS、Linux、WSL（bash/zsh）：

```sh
set -eu
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 --branch main https://github.com/MisonL/chatgpt-store-download.git "$tmp/repo"
dest="${CODEX_HOME:-$HOME/.codex}/skills/chatgpt-store-download"
mkdir -p "$dest"
cp -R "$tmp/repo/chatgpt-store-download/." "$dest/"
echo "已安装到 $dest"
```

Windows PowerShell：

```powershell
$ErrorActionPreference = 'Stop'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("chatgpt-store-download-" + [guid]::NewGuid())
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$dest = Join-Path $codexHome 'skills\chatgpt-store-download'
try {
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    git clone --depth 1 --branch main https://github.com/MisonL/chatgpt-store-download.git (Join-Path $tmp 'repo')
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $tmp 'repo\chatgpt-store-download\*') -Destination $dest -Recurse -Force
    Write-Host "已安装到 $dest"
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
}
```

安装后可通过 `$chatgpt-store-download` 调用。若 Codex 已加载旧版本，请重新打开会话。

## 使用

在 Skill 目录中执行：

```sh
node scripts/fetch_links.js --arch x64
node scripts/fetch_links.js --arch x64 --json
node scripts/fetch_links.js --arch both --json
node scripts/fetch_links.js --self-test --json
node scripts/fetch_links.js --arch x64 --strict-tls --json
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--arch x64\|arm64\|both` | 目标 Windows 架构，默认 `x64` |
| `--json` | 输出机器可读 JSON |
| `--self-test` | 离线自测，不访问网络、不写入磁盘 |
| `--strict-tls` | 启用 TLS 证书和主机名校验 |
| `--timeout 45` | 单次请求超时，范围 `1-300` 秒 |

Windows CMD 若中文乱码，先执行 `chcp 65001`；PowerShell、WSL 和 macOS/Linux 通常可直接使用 UTF-8。NVM 等版本管理器必须在当前 shell 中先加载，使 `node --version` 可用。

## 重要边界

- 只查询和校验官方临时直链，不下载完整 MSIX、不安装应用、不获取 Microsoft Store 许可证。
- 默认兼容模式跳过 TLS 证书校验，结果会标记 `tls_verified: false` 并显示安全警告；严格校验使用 `--strict-tls`。
- 直链包含短时签名，不要长期缓存、公开日志记录或手工拼接；失效后重新查询。
- Skill 不保证 Windows 1809/1909、精简系统、缺失 Store 组件或完全内网环境可以安装和登录。
- `url_verified` 只表示元数据与 CDN 探针一致，不代表完整文件已下载或许可证可用。

## 验证

```sh
node --check scripts/fetch_links.js
node scripts/fetch_links.js --self-test --json
```

当前离线自测为 19 项；它不替代真实微软接口、CDN、Windows 安装、签名和许可证验收。

## 目录结构

```text
chatgpt-store-download/
├── README.md
├── LICENSE
├── .gitattributes
├── .gitignore
└── chatgpt-store-download/
    ├── SKILL.md
    ├── agents/openai.yaml
    └── scripts/fetch_links.js
```

## 许可证

[MIT License](LICENSE)
