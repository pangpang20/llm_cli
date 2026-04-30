# LLM CLI Agent

一个类似 Claude Code 的命令行 AI 助手工具。通过浏览器登录 Qwen 账号即可在终端中与 AI 对话，AI 可以自动调用工具完成文件读写、Shell 命令执行、浏览器操作等任务。

## 工作原理

```
终端输入 ──> 认证 Cookie ──> Qwen 网页 API ──> AI 回复 ──> 工具执行
```

1. 首次运行自动打开浏览器，扫码登录 [chat.qwen.ai](https://chat.qwen.ai/)
2. 登录成功后提取 Cookie 保存到本地
3. 后续通过 Cookie 调用 Qwen 网页内部 API，无需 API Key

## 功能特性

- **浏览器登录** — 打开浏览器扫码登录，自动获取认证信息
- **交互式 REPL** — 在终端中与 AI 自由对话
- **文件操作** — 读取、创建、编辑文件，路径限制在项目目录内
- **Shell 命令** — 执行任意终端命令
- **浏览器自动化** — 打开网页、截图、提取文本、点击、输入
- **会话持久化** — Cookie 保存 12 小时，无需重复登录

## 工具列表

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容（限制在项目目录） |
| `write_file` | 创建或覆盖文件（限制在项目目录） |
| `edit_file` | 精确文本替换（限制在项目目录） |
| `bash` | 执行 Shell 命令 |
| `browser_navigate` | 打开指定 URL |
| `browser_screenshot` | 对当前页面截图 |
| `browser_text` | 提取页面文本内容 |
| `browser_click` | 点击页面上的元素 |
| `browser_type` | 在输入框中输入文本 |

## 安装

```bash
# 克隆仓库
git clone git@github.com:pangpang20/llm_cli.git
cd llm_cli

# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

## 使用

### 1. 启动 & 登录

```bash
npm start
```

首次运行会自动打开浏览器：

1. 弹出浏览器窗口，打开 [chat.qwen.ai](https://chat.qwen.ai/)
2. 扫码或输入账号密码登录
3. 登录成功后浏览器自动关闭，认证信息保存到 `.qwen_session.json`
4. 进入终端对话界面

之后 12 小时内再次运行无需登录。

### 2. 开始对话

```
=== LLM CLI Agent ===
Type /help for commands. Ctrl+C to exit.

> 帮我创建一个 Hello World 的 Python 脚本
```

AI 会直接调用工具完成任务，无需手动操作。

### 3. 内置命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/clear` | 清空对话历史 |
| `/login` | 重新打开浏览器登录 |
| `/quit` 或 `/exit` | 退出程序 |

### 4. 会话管理

| 文件 | 说明 |
|------|------|
| `.qwen_session.json` | 认证 Cookie，12 小时过期 |

```bash
# 强制重新登录
rm .qwen_session.json
npm start
```

### 5. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NO_SANDBOX` | `0` | 设为 `1` 时禁用浏览器沙箱（Docker/CI 环境） |

## 开发

```bash
# 监听模式，自动重新编译
npm run dev

# 手动编译
npm run build

# 类型检查
npm run lint
```

## 项目结构

```
src/
  index.ts              - REPL 主循环入口
  auth.ts               - 浏览器登录 & 会话管理
  chat.ts               - 对话历史管理（OpenAI 类型兼容层，备用）
  provider/
    dashscope.ts        - DashScope API 封装（备用）
    qwen_web.ts         - Qwen 网页版 API 封装
  tools/
    types.ts            - 工具接口定义
    read.ts             - 文件读取
    write.ts            - 文件写入
    edit.ts             - 文件编辑
    bash.ts             - Shell 命令
    browser.ts          - 浏览器自动化（导航/截图/文本/点击/输入）
    index.ts            - 工具注册导出
```
