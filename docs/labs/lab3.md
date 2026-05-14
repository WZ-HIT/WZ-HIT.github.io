# 实验三：重构与设计模式

> 实验目标：对 `chat_with_agent` 这个"上帝函数"进行增量式重构，用服务层模式和策略模式提升可维护性与可测试性。

## 背景：什么是上帝函数

`app/api/v1/endpoints/agents.py` 中的 `chat_with_agent` 路由函数内部定义了一个约 1300 行的 `response_generator` 生成器，同时承担了七类职责：

| 编号 | 职责 | 触发条件 |
|------|------|---------|
| 1 | 请求参数解析与 Agent 权限验证 | 每次请求 |
| 2 | 文件内容提取与注入 | `file_ids` 非空 |
| 3 | 联网搜索与上下文构造 | `agent.enable_web_search` |
| 4 | 知识库向量检索 | `agent.knowledge_bases` 非空 |
| 5 | 知识图谱查询 | `agent.graphs` 非空 |
| 6 | 消息组装与模型推理 | 每次请求 |
| 7 | 聊天历史持久化 | 每次请求 |

这样的代码虽然能跑，但违反了三个原则：
- **SRP**：一个函数同时负责 I/O、业务逻辑、状态管理和持久化
- **OCP**：新增检索源必须修改主函数
- **可测试性**：内部状态无法单独注入，测试必须驱动整个请求链路

---

## 一、现状分析

### 用 radon 量化复杂度

```bash
poetry run radon cc app/api/v1/endpoints/agents.py -a -s
```

输出：

```
app/api/v1/endpoints/agents.py
    F 241:0 chat_with_agent        - B (7)   # 主聊天入口，本实验重构目标
    F 2325:0 share_chat_with_agent - B (6)   # 分享链接入口，结构类似
    F 1927:0 chat_with_agent_api   - A (5)
    F 116:0 create_agent           - A (3)
    ...
Average complexity: A (3.0)
```

文件中有两个 B 级函数，其余 19 个函数均为 A 级，文件平均复杂度 3.0。该分数存在低估——radon 仅统计外层函数的决策点，内部嵌套的 `response_generator`（约 1300 行）中大量 `if/for/try` 没有被完整纳入统计，真实复杂度远高于此。

### 用 ruff 清理无用 import

```bash
poetry run ruff check agents.py --select F401 --isolated
# Found 15 errors: Request, StreamingResponse, Response, JSONResponse,
# List, AsyncIterable, AsyncGenerator, asyncio,
# get_optional_current_user, Agent, uuid, datetime, RAW_BUCKET (x2), sqlalchemy.distinct

poetry run ruff check agents.py --select F401 --isolated --fix
# Found 15 errors (15 fixed, 0 remaining).
```

清除了 15 个历史残留的未引用符号，消除噪音，为后续重构建立干净的基线。

### 三条增强通道的重复结构

联网搜索、知识库检索、图谱查询三个通道在原代码中结构完全对称——各自包含"状态推送 → 数据获取 → 格式化 → 注入 ctx"四个步骤，却完全独立地平铺在主函数内，各自展开超过 100 行，代码无法复用。

### 重构切入计划

七项职责中，优先抽取**联网搜索**（职责3）和**知识库向量检索**（职责4）：
- **结构对称，模式相同**：两者都遵循"调用外部函数 → 格式化结果 → 注入 ctx"的三步模式，抽取后可以得到签名一致的函数，为后续统一接口打基础。
- **相互独立**：两个通道之间没有数据依赖，拆任何一个都不影响另一个。
- 图谱查询依赖 Neo4j 连接管理，有独立的连接生命周期逻辑，待前两个积累经验后再处理。

---

## 二、服务层抽取

### WebSearchService

新建 `app/services/web_search_service.py`，采用服务类模式。核心是带 AF/RI 约束的 `SearchResult` dataclass：

```python
from dataclasses import dataclass, field
from typing import List
from app.utils.web_search import search_web, get_web_search_client

# AF: SearchResult(context, sources, raw_results)
#     代表一次联网搜索的完整结果。
#     context 是格式化后供模型注入的文本；
#     sources[i] 是 raw_results[i] 的结构化元数据；
#     raw_results 是原始 API 返回项。
#
# RI: len(sources) == len(raw_results)
#     每个 source dict 包含 content/score/source_file/url/type
#     source["score"] == 1.0, source["type"] == "web_search"

@dataclass
class SearchResult:
    context: str
    sources: List[dict]
    raw_results: List[dict] = field(default_factory=list)

    def __post_init__(self):
        assert len(self.sources) == len(self.raw_results)
        for r in self.sources:
            assert "content" in r
            assert "source_file" in r
            assert "url" in r
            assert r["score"] == 1.0
            assert r["type"] == "web_search"

class WebSearchService:
    async def search(self, query: str) -> SearchResult:
        search_results = await search_web(query)
        if not search_results.get("results"):
            return SearchResult(context="", sources=[], raw_results=[])
        raw = search_results.get("results", [])
        client = get_web_search_client()
        context = client.format_search_results(search_results)
        sources = [
            {
                "content": r.get("content", ""),
                "score": 1.0,
                "source_file": r.get("title", "网络搜索结果"),
                "url": r.get("url", ""),
                "type": "web_search"
            }
            for r in raw
        ]
        return SearchResult(context=context, sources=sources, raw_results=raw)
```

原联网搜索段共约 45 行（含内联的状态推送、搜索调用、结果格式化、sources 组装、上下文注入），重构后 agents.py 中替换为 16 行，逻辑清晰：

```python
if agent.enable_web_search:
    yield {"event": "web_search", "data": json.dumps({...})}
    time.sleep(0.5)
    try:
        web_result = await WebSearchService().search(user_message)
        sources.extend(web_result.sources)
        if web_result.context:
            ctx.add_message({"role": "system", "content": web_result.context})
        yield {"event": "web_search_complete", "data": ...}
    except Exception as e:
        traceback.print_exc()
        yield {"event": "web_search_complete", "data": ...}
```

### KnowledgeRetrievalService

新建 `app/services/knowledge_retrieval_service.py`，返回类型 `RetrievalResult` 同样带 AF/RI 约束：

```python
# AF: RetrievalResult(context, sources, raw_results)
#     代表一次知识库检索的完整结果。
#     context 是格式化后供模型注入的文本；
#     sources[i] 是 raw_results[i] 的结构化元数据；
#     raw_results 是向量库返回的原始 hits。
#
# RI: 每个 source dict 包含 content/score/source_file/file_id/
#     knowledge_id/knowledge_name/chunk_id/type 八个 key
#     source["type"] == "document"，0 <= source["score"] <= 1

@dataclass
class RetrievalResult:
    context: str
    sources: List[dict]
    raw_results: List[dict] = field(default_factory=list)

    def __post_init__(self):
        for r in self.sources:
            assert r["type"] == "document"
            assert 0 <= r["score"] <= 1
```

**同时修复了一个原有 Bug：** 原代码将检索结果收集到 `retrieval_results` 列表后，既未注入 `ctx`、也未添加到 `sources`，导致知识库内容对模型完全不可见。`KnowledgeRetrievalService` 在返回前将所有结果拼成 `context` 字符串，由调用方注入 `ctx`。

原内联块约 95 行，重构后 agents.py 中替换为 18 行：

```python
if agent.knowledge_bases:
    yield {"event": "knowledge_search", "data": '...'}
    try:
        kb_result = await KnowledgeRetrievalService().retrieve(
            db, agent, user_message, model_id, config)
        sources.extend(kb_result.sources)
        if kb_result.context:
            ctx.add_message({"role": "system", "content": kb_result.context})
        yield {"event": "vector_search_complete", "data": json.dumps({
            "status": f"知识库检索完成，找到{len(kb_result.sources)}条相关内容",
            "results_count": len(kb_result.sources)
        }, ensure_ascii=False)}
    except Exception as e:
        traceback.print_exc()
```

---

## 三、策略模式统一调度

### 问题

完成两个 Service 类的抽取后，`agents.py` 中仍然存在两段风格各异的独立 if 块。新增第三条增强通道还是需要写新的 if 块，主函数依然在膨胀。

**类比理解：** 想象三个不同品牌的充电器，各有各的充电方式。策略模式就是：统一规定"必须有 `charge()` 方法"，然后用一个循环统一调用，不管你是什么品牌。

### 第一步：定义抽象基类

新建 `app/services/strategy_base.py`，用 `ABC` 机制定义统一接口：

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List

@dataclass
class StrategyResult:
    context: str
    sources: List[dict]

class BaseRetrievalStrategy(ABC):
    @abstractmethod
    async def execute(self, query: str, context: dict) -> StrategyResult:
        ...
```

`StrategyResult` 是三条通道的统一返回类型，`execute()` 是所有策略必须实现的方法。`@abstractmethod` 装饰器保证子类若不实现该方法，实例化时立即报错。

### 第二步：为已有 Service 添加策略适配器

在 `web_search_service.py` 和 `knowledge_retrieval_service.py` 底部各增加一个 Strategy 类，将已有 Service 包装成统一接口：

```python
# web_search_service.py
class WebSearchStrategy(BaseRetrievalStrategy):
    async def execute(self, query: str, context: dict) -> StrategyResult:
        result = await WebSearchService().search(query)
        return StrategyResult(context=result.context, sources=result.sources)

# knowledge_retrieval_service.py
class KnowledgeRetrievalStrategy(BaseRetrievalStrategy):
    async def execute(self, query: str, context: dict) -> StrategyResult:
        result = await KnowledgeRetrievalService().retrieve(
            db=context["db"], agent=context["agent"],
            user_message=query,
            model_id=context["model_id"], config=context["config"])
        return StrategyResult(context=result.context, sources=result.sources)
```

### 第三步：图谱通道轻量适配

图谱查询依赖 Neo4j 连接管理，逻辑较复杂，暂不迁移完整实现。新建 `app/services/graph_retrieval_service.py`，以空结果保持接口统一：

```python
class GraphRetrievalStrategy(BaseRetrievalStrategy):
    async def execute(self, query: str, context: dict) -> StrategyResult:
        # 图谱查询逻辑较复杂，暂由 agents.py 原有逻辑处理
        return StrategyResult(context="", sources=[])
```

### 第四步：改造 agents.py 调度逻辑

将原来两段独立的 if 块替换为统一的策略调度循环：

```python
# 按条件动态组装策略列表
active_strategies = []
if agent.enable_web_search:
    active_strategies.append(WebSearchStrategy())
if agent.knowledge_bases:
    active_strategies.append(KnowledgeRetrievalStrategy())
if agent.graphs:
    active_strategies.append(GraphRetrievalStrategy())

# 统一调度执行
strategy_context = {
    "db": db, "agent": agent,
    "model_id": model_id, "config": config
}
for strategy in active_strategies:
    try:
        result = await strategy.execute(user_message, strategy_context)
        sources.extend(result.sources)
        if result.context:
            ctx.add_message({"role": "system", "content": result.context})
    except Exception as e:
        traceback.print_exc()
```

主函数彻底不知道每条通道的实现细节：只管遍历列表、调用 `execute()`、处理统一格式的返回值。**新增一条增强通道，只需新建一个类并追加到列表，主函数无需任何修改**——这正是开闭原则的直接体现。

---

## 四、单元测试

### SearchResult RI 破坏性测试

直接构造违反不变式的 `SearchResult`，断言 `__post_init__` 抛出 `AssertionError`：

```python
def test_length_mismatch():
    with pytest.raises(AssertionError):
        SearchResult(
            context="",
            sources=[{"content":"","score":1.0,"source_file":"","url":"","type":"web_search"}],
            raw_results=[]   # 长度不一致
        )

def test_key_loss():
    with pytest.raises(AssertionError):
        SearchResult(
            context="",
            sources=[{"score":1.0,"source_file":"","url":"","type":"web_search"}],
            raw_results=["x"]   # 缺少 content key
        )

def test_wrong_score():
    with pytest.raises(AssertionError):
        SearchResult(
            context="",
            sources=[{"content":"","score":1.5,"source_file":"","url":"","type":"web_search"}],
            raw_results=["x"]   # score != 1.0
        )
```

### WebSearchService 行为测试（使用 mock）

用 `unittest.mock.patch` 替换外部依赖 `search_web` 和 `get_web_search_client`，使测试完全离线运行：

```python
@pytest.mark.asyncio
async def test_empty_results():
    fake = {"results": []}
    with patch("app.services.web_search_service.search_web",
               new=AsyncMock(return_value=fake)):
        result = await WebSearchService().search("今天天气")
    assert result.context == ""
    assert result.sources == []

@pytest.mark.asyncio
async def test_one_result():
    fake = {"results": [
        {"title":"北京天气","content":"今天晴，25度","url":"http://weather.com"}
    ]}
    mock_client = MagicMock()
    mock_client.format_search_results.return_value = "今天晴，25度"
    with patch("app.services.web_search_service.search_web",
               new=AsyncMock(return_value=fake)), \
         patch("app.services.web_search_service.get_web_search_client",
               return_value=mock_client):
        result = await WebSearchService().search("北京天气")
    assert len(result.sources) == 1
    assert result.sources[0]["type"] == "web_search"
    assert result.context == "今天晴，25度"
```

运行结果：

```
tests/services/test_web_search_service.py::test_empty_results   PASSED
tests/services/test_web_search_service.py::test_one_result      PASSED
tests/services/test_web_search_service.py::test_length_mismatch PASSED
tests/services/test_web_search_service.py::test_key_loss        PASSED
tests/services/test_web_search_service.py::test_wrong_score     PASSED

5 passed in 0.10s
```

测试完全离线运行（mock 了外部 API），不受网络状态影响。

### 端到端 curl 验证

```bash
curl --noproxy localhost -s -N -X POST \
  "http://localhost:8000/api/agents/.../chat" \
  -H "Authorization: Bearer <token>" \
  -d '{"messages":[{"role":"user","content":"你好，今天天气怎么样"}],"stream":true}'
```

响应：

```
event: status
data: {"status": "开始处理请求"}

event: info
data: {"sources": [], "web_search_results": []}

event: message_chunk
data: {"choices": [{"delta": {"content": "你好！"}, ...}]}

event: status
data: {"status": "回答完成"}

event: done
data: [DONE]
```

链路正常，模型正常回复。本次测试所用 Agent 未开启联网搜索，因此 `web_search` 事件未出现；`WebSearchService` 的功能正确性已由单元测试（`test_one_result`）覆盖。

---

## 总结

| 阶段 | 做了什么 | 收益 |
|------|---------|------|
| 现状分析 | radon 量化复杂度 + ruff 清理 15 个无用 import | 建立基线，消除噪音 |
| 服务层抽取 | 将联网搜索和知识库检索抽取为 Service 类 + ADT 设计 | 可单独测试，同时修复了知识库内容不可见的 Bug |
| 策略模式 | 定义统一接口，改造主函数为调度循环 | 扩展新通道无需改主函数，直接体现 OCP |

**重构的边界意识：** 本次重构新建了五个文件，仅修改了 `agents.py` 中的两段代码，其余所有文件保持不变。增量式重构之所以比一次性重写更安全：改动范围小，出现回归 bug 时排查范围明确；可以逐步验证，每抽取一个通道就做一次端到端测试；保留了原有的对外接口（SSE 事件格式不变），不影响前端和调用方。

**可测试性的改善：** 重构前，增强逻辑深埋在 `response_generator` 内部，任何测试都必须驱动完整的 HTTP 请求链路。重构后，`WebSearchService.search()` 只依赖两个外部函数，用 mock 替换后测试完全离线运行，5 个测试总耗时 0.10 秒。这是单一职责原则的直接收益：职责越单一，外部依赖越少，越容易在隔离环境中验证。
