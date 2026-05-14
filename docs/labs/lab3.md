# 实验三：重构与设计模式

> 实验目标：对 `chat_with_agent` 这个"上帝函数"进行增量式重构，用服务层模式和策略模式提升可维护性与可测试性。

## 背景：什么是上帝函数

`app/api/v1/endpoints/agents.py` 中的 `chat_with_agent` 路由函数内部定义了一个约 1300 行的 `response_generator` 生成器，同时承担了七类职责：

| 编号 | 职责 | 触发条件 |
|------|------|---------|
| 1 | 请求参数解析与权限验证 | 每次请求 |
| 2 | 文件内容提取与注入 | `file_ids` 非空 |
| 3 | 联网搜索与上下文构造 | `agent.enable_web_search` |
| 4 | 知识库向量检索 | `agent.knowledge_bases` 非空 |
| 5 | 知识图谱查询 | `agent.graphs` 非空 |
| 6 | 消息组装与模型推理 | 每次请求 |
| 7 | 聊天历史持久化 | 每次请求 |

这样的函数虽然能跑，但违反了三个原则：
- **SRP**：一个函数同时负责 I/O、业务逻辑、状态管理和持久化
- **OCP**：新增检索源必须修改主函数
- **可测试性**：内部状态无法单独注入，测试必须驱动整个请求链路

## 任务一：复杂度量化与代码清理

### 用 radon 量化复杂度

```bash
poetry run radon cc app/api/v1/endpoints/agents.py -a -s
```

输出：
```
F 241:0 chat_with_agent        - B (7)
F 2325:0 share_chat_with_agent - B (6)
...
Average complexity: A (3.0)
```

radon 的分数存在低估——它只统计外层函数的决策点，内部嵌套的 `response_generator` 中大量 `if/for/try` 没有被完整纳入统计，真实复杂度远高于此。

### 用 ruff 清理无用 import

```bash
poetry run ruff check agents.py --select F401 --isolated --fix
# Found 15 errors (15 fixed, 0 remaining)
```

清除了 15 个历史残留的未引用符号，包括 `Request`、`StreamingResponse`、`uuid`、`datetime` 等。

## 任务二：服务下沉

### 设计思路

三条"信息增强"通道（联网搜索、知识库检索、图谱查询）在原代码中以相似的结构平铺展开，每条通道各自独立展开超过 100 行，且代码无法复用。

重构目标：将每个通道的逻辑剥离为独立的 Service 类，主函数只负责编排流程。

### WebSearchService

新建 `app/services/web_search_service.py`，核心是带 AF/RI 约束的 `SearchResult` ADT：

```python
# AF: SearchResult(context, sources, raw_results) 代表一次联网搜索的完整结果
# RI: len(sources) == len(raw_results)
#     source["score"] == 1.0, source["type"] == "web_search"

@dataclass
class SearchResult:
    context: str
    sources: List[dict]
    raw_results: List[dict] = field(default_factory=list)

    def __post_init__(self):
        assert len(self.sources) == len(self.raw_results)
        for r in self.sources:
            assert r["score"] == 1.0
            assert r["type"] == "web_search"
```

原代码约 45 行内联逻辑，重构后主函数只剩 16 行调用。

### KnowledgeRetrievalService

新建 `app/services/knowledge_retrieval_service.py`。

这里还顺手修复了一个原有 bug：**原代码将检索结果收集到列表后既未注入 `ctx`、也未添加到 `sources`**，导致知识库内容对模型完全不可见。Service 在返回前将结果拼成 `context` 字符串，由调用方注入。

```python
# AF: RetrievalResult 代表一次知识库检索的完整结果
# RI: source["type"] == "document", 0 <= source["score"] <= 1

@dataclass
class RetrievalResult:
    context: str
    sources: List[dict]
    raw_results: List[dict] = field(default_factory=list)
```

### 单元测试

用 `pytest + unittest.mock` 对 `WebSearchService` 编写了 5 个测试：

```
test_empty_results    PASSED  # 无结果时返回空 SearchResult
test_one_result       PASSED  # 有结果时正确组装 sources 和 context
test_length_mismatch  PASSED  # RI：sources 和 raw_results 长度必须相等
test_key_loss         PASSED  # RI：source dict 必须有完整的 key
test_wrong_score      PASSED  # RI：score 必须是 1.0

5 passed in 0.10s
```

测试完全离线运行（mock 了外部 API），不受网络状态影响。

## 任务三：策略模式统一调度

### 问题

完成两个 Service 类的抽取后，`agents.py` 中仍然存在两段风格各异的独立 if 块。

### 解决方案

新建抽象基类 `BaseRetrievalStrategy`：

```python
class BaseRetrievalStrategy(ABC):
    @abstractmethod
    async def execute(self, query: str, context: dict) -> StrategyResult:
        ...
```

为每个 Service 添加策略适配器（Adapter），将已有实现包装成统一接口：

```python
class WebSearchStrategy(BaseRetrievalStrategy):
    async def execute(self, query, context) -> StrategyResult:
        result = await WebSearchService().search(query)
        return StrategyResult(context=result.context, sources=result.sources)

class KnowledgeRetrievalStrategy(BaseRetrievalStrategy):
    async def execute(self, query, context) -> StrategyResult:
        result = await KnowledgeRetrievalService().retrieve(
            db=context["db"], agent=context["agent"],
            user_message=query, model_id=context["model_id"],
            config=context["config"])
        return StrategyResult(context=result.context, sources=result.sources)
```

主函数改为统一调度循环：

```python
# 按条件动态组装策略列表
active_strategies = []
if agent.enable_web_search:
    active_strategies.append(WebSearchStrategy())
if agent.knowledge_bases:
    active_strategies.append(KnowledgeRetrievalStrategy())
if agent.graphs:
    active_strategies.append(GraphRetrievalStrategy())

# 统一执行
for strategy in active_strategies:
    result = await strategy.execute(user_message, strategy_context)
    sources.extend(result.sources)
    if result.context:
        ctx.add_message({"role": "system", "content": result.context})
```

**新增一条增强通道**，只需新建一个类并追加到列表，主函数无需任何修改——这正是开闭原则的直接体现。

## 总结

| 阶段 | 做了什么 | 收益 |
|------|---------|------|
| 任务一 | radon 量化 + ruff 清理 | 建立基线，消除噪音 |
| 任务二 | Service 类抽取 + ADT 设计 | 可单独测试，修复隐藏 bug |
| 任务三 | 策略模式统一调度 | 扩展新通道无需改主函数 |
