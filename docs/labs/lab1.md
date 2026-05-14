# 实验一：环境搭建

> 实验目标：从零搭建项目开发环境，完成依赖安装、数据库初始化和服务启动验证。

## 环境信息

- 操作系统：macOS Sequoia 15.x
- Python：3.12（通过 pyenv 管理）
- 包管理器：Poetry
- 数据库：MySQL 8.x、Redis

## 主要步骤

### 1. 安装依赖

```bash
poetry install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填写数据库连接信息、JWT Secret 等。

### 3. 初始化数据库

```bash
poetry run alembic upgrade head
```

### 4. 启动服务

```bash
poetry run uvicorn app.main:app --reload
```

访问 `http://localhost:8000/docs` 确认 API 文档正常加载。

## 踩坑记录

**代理拦截 localhost 请求**

系统设置了 Clash 代理（`http_proxy=http://127.0.0.1:7890`），curl 把本地请求也转发给了代理，返回 502。

解决：所有 curl 命令加 `--noproxy localhost` 参数。

```bash
curl --noproxy localhost http://localhost:8000/api/...
```
