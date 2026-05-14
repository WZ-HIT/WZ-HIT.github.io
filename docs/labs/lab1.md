# 实验一：环境搭建与工程化改造

> 实验目标：将一个快速开发的 AI 后端项目（CogmAIt）从"能跑"状态改造为"可维护"状态——迁移依赖管理工具、编写第一批单元测试、定位并记录代码缺陷。

## 背景

CogmAIt 是一个 AI 后端服务，早期为了追求速度牺牲了工程化规范：

- 用简单的 `pip + requirements.txt` 管理依赖，导致环境不一致、"依赖地狱"等问题
- 测试覆盖率极低，`app/utils` 中的工具函数缺乏保障，修改它们可能引发不可预知的连锁反应

## 一、项目初探：读懂他人的代码

### 用 Swagger UI 分析接口

FastAPI 自动生成的 Swagger UI（`/docs`）直观展示了每个接口的参数。以 `GET /api/agents` 为例，需要输入 `page`、`limit`、`name`、`type`、`status`，其中后三个可为空。

### 发现冗余代码

**冗余一：永远不会执行的防御判断**

```python
# 通过 token 或 agent_id 获取 agent
if token:
    agent = agent_utils.get_agent_by_share_token(db, token)
    if not agent:
        raise HTTPException(status_code=401, detail="分享令牌无效或已禁用")

if not agent:
    agent = agent_utils.get_agent(db=db, agent_id=agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="智能体不存在")

# ← 这段代码永远不会执行
if not agent:
    raise HTTPException(status_code=500, detail="初始化智能体失败")
```

走到最后一个 `if not agent` 时，`agent` 只有两种可能：已被成功赋值，或前面某个分支已经 `raise` 直接返回了。**不存在任何代码路径能让 `agent` 为 `None` 且同时到达这里。** 这是一段永远不可能执行的冗余保护代码。

**冗余二：把字典当对象用**

```python
if ragList:
    graphListData = {
        "nodes": [{"id": n.id, "name": n.name, ...} for n in graphList["nodes"]],
        "links": [{"id": l.id, "source": l.source, ...} for l in graphList["links"]]
    }
```

Python 字典不支持点号属性访问，`n.id` 会直接抛出 `AttributeError`，应写为 `n["id"]`。这意味着**只要图谱查询返回结果，代码就会崩溃**。

---

## 二、迁移至 Poetry

### 为什么要迁移

`requirements.txt` 只记录顶层依赖，不锁定传递依赖的版本。不同时间在不同机器上安装，可能得到不同版本的间接依赖，导致"在我电脑上能跑"的经典问题。

Poetry 用 `pyproject.toml` + `poetry.lock` 双文件管理，`poetry.lock` 精确锁定每一个依赖的版本，保证任何人在任何机器上 `poetry install` 得到完全相同的环境。

### 踩坑：依赖地狱

迁移时遇到了一个典型的"依赖地狱"问题：

- `mineru`（PDF 解析库）对 `openai` 有严格的旧版本约束（1.x）
- `langchain-openai` 要求 `openai` 2.x

两者根本无法共存于同一环境。**正确的解法是将重型 ML 模块拆分为独立微服务**，与主服务隔离运行，各自维护自己的环境。

### 迁移步骤

从 `requirements.txt` 提取锁定版本作为最低版本约束，忽略 `torch`、`mineru`、`modelscope` 等风险极大的重型 ML 包，将所有依赖写入 `pyproject.toml`：

```bash
poetry lock
poetry install
poetry run uvicorn app.main:app --reload
```

---

## 三、编写第一批单元测试

### 测试 `app/utils/__init__.py`

针对 `format_datetime` 和 `utc_to_cst` 两个时间处理函数编写了 7 个测试用例：

```python
def test_NULL_to_empty():
    assert format_datetime(None) == ""

def test_normal_time_format():
    dt = datetime(2024, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    assert format_datetime(dt) == "2024-01-15T00:00:00"

def test_format_datetime_tzinfo_none():
    dt = datetime(2024, 1, 1, 0, 0)
    assert format_datetime(dt) == "2024-01-01T08:00:00"  # 自动转换为 CST

def test_utc_to_cst_tzinfo():
    dt = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    assert utc_to_cst(dt).hour == 8
```

最终 `__init__.py` 的测试覆盖率达到 **100%**。

### 测试 `app/utils/config.py`：处理全局缓存

`config.py` 存在一个全局缓存变量 `_config`：第一次调用 `load_config()` 后结果会被缓存，后续调用直接返回缓存值。**若不处理，测试 A 产生的缓存会污染测试 B 的初始状态。**

解决方案：用 pytest 的 `fixture` 机制，在每个测试前后自动重置缓存：

```python
@pytest.fixture(autouse=True)
def reset_cache():
    config_module._config = None   # 测试开始前清空
    yield                          # 测试本体在此执行
    config_module._config = None   # 测试结束后再次清空
```

同时用 `monkeypatch` 伪造外部依赖，让测试不依赖本地文件系统：

```python
monkeypatch.setattr("os.path.exists", lambda x: False)  # 伪造文件不存在
monkeypatch.setenv("NEO4J_URI", "bolt://test:7687")      # 注入环境变量
```

### 测试反哺重构：让代码更易测试

为 `update_neo4j_config` 编写测试时，发现必须同时 monkeypatch **两个**内部状态，根本原因是 `save_config` 的写入路径被硬编码在函数内部：

```python
# 重构前：路径硬编码，外部无法干预
def save_config(config: Dict[str, Any]) -> bool:
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f)
```

将路径改为带默认值的参数：

```python
# 重构后：路径由调用者决定，默认值保持向后兼容
def save_config(config: Dict[str, Any], path: str = CONFIG_PATH) -> bool:
    with open(path, "w") as f:
        json.dump(config, f)
```

重构后测试直接传入 `tmp_path`，无需任何 monkeypatch，代码也更清晰。`config.py` 覆盖率从 85% 提升至 **89%**。

### 测试中发现的 Bug：`format_datetime` 时区不一致

写测试时发现：**同一时刻**，以 naive datetime 与 UTC-aware datetime 两种方式传入，输出结果**相差 8 小时**。

```python
dt_naive = datetime(2024, 1, 1, 0, 0, 0)
dt_aware = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

format_datetime(dt_naive)  # => "2024-01-01T08:00:00"（转换为 CST）
format_datetime(dt_aware)  # => "2024-01-01T00:00:00"（未转换，直接输出 UTC）
```

根因：函数只对 `tzinfo is None` 的 datetime 做 UTC→CST 转换，对已携带时区的 datetime 直接格式化。数据库读取的时间字段通常带 `tzinfo=timezone.utc`，传入后会以 UTC 返回给前端，造成时间显示错误。

建议修复：统一在函数入口处转换为 CST：

```python
def format_datetime(dt: datetime, include_timezone: bool = False) -> str:
    if dt is None:
        return ""
    dt = utc_to_cst(dt)  # 统一转 CST，naive 和 aware 均正确处理
    ...
```

---

## 总结

| 维度 | 收获 |
|------|------|
| 读代码 | 发现两处冗余/缺陷：永远不执行的防御判断、字典当对象访问 |
| 依赖管理 | Poetry 双文件锁定依赖，彻底解决环境不一致；依赖冲突的正确解法是拆微服务 |
| 单元测试 | autouse fixture 隔离全局状态，monkeypatch 伪造外部依赖；写测试的过程中发现了时区 bug |
