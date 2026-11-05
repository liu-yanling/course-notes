# dsh-video-coursemap · 视频课程知识地图 Agent 2.1（macOS 增强版）

> 基于 linner1224/dsh-video-coursemap v2.0.0（MIT）的本地增强版，保留插件 id、
> 工具名与输出理念，重写 macOS 检测、Word 文档与 DSH 新会话交付，并接入
> dsh-memory-evolve 的项目记忆。

把「在浏览器里看 B 站课程」变成一套自动知识管线：

1. **实时检测**：每 15s 观察当前前台浏览器，发现新的 B 站视频才工作；同一个
   视频再次出现时完全静默。
2. **学科分类**：根据标题、标签、简介、分 P、弹幕/评论关键词判断学科；已有学科
   追加到该学科《学习手册.docx》，全新学科自动新建学习手册。
3. **知识总结**：抓取视频简介、分 P、标签、字幕（尽力）、弹幕、热评，生成
   视频知识笔记 Word，并自动新建一个 DSH 会话，在聊天区用 `present` 交付文档。
4. **跨会话记忆**：启用 dsh-memory-evolve 后，交付会话会把学科与核心概念写入
   项目记忆，后续新会话能读到“我学过什么”。

## macOS 检测说明

| 浏览器 | 方式 | 精度 |
| --- | --- | --- |
| Tabbit Browser | tabbit-cli 读取当前标签页 | 精确（推荐） |
| Chrome / Edge / Brave / Arc | 读取该浏览器 History 中 30 分钟内最新 B 站视频 URL + 前台应用判断 | 近似：无法区分当前是否停在 B 站标签页 |
| Safari | AppleScript 尽力；失败静默降级 | 取决于系统自动化权限 |
| 任意 | `course_map_scan({title|url})` 手动指定 | 精确 |

> DSH Desktop 当前构建没有 AppleEvents 权限声明，Chrome 的 AppleScript 通常会被
> macOS 拒绝；因此 Chrome 走 History 近似方案。演示建议用 Tabbit，或直接用
> `course_map_scan` 指定 URL。

## B 站内容抓取

- `x/web-interface/view`：标题、简介、UP、aid/cid、分 P/章节、统计
- `x/tag/archive/tags`：标签
- `comment.bilibili.com/<cid>.xml`：弹幕；按时间分 10 桶抽样、过滤口水话、最多 120 条
- `x/v2/reply?sort=2`（失败回退 `x/v2/reply/main`）：热评，带 buvid3 Cookie
- 字幕：`view.subtitle.list` / `player/v2` 尽力；多数视频为空
- 失败自动降级为“仅标题/元数据总结”，并在 Word 中标注覆盖度

B 站的 AI 总结接口（`view/conclusion/get`）需要登录，返回 -403；本插件不依赖它。

## Word 输出

每个视频生成：

```
课程知识地图/
├── 课程总览.docx                  # 学科总览 + 学科列表 + 最近学习
├── 知识地图.md                    # 总览的 Markdown 源
├── <学科A>/
│   └── 学习手册.docx              # 该学科所有视频的知识地图
├── 视频笔记/
│   └── <日期>_<标题>_<bvid>.docx  # 单视频知识总结（主交付物）
└── .state/
    ├── state.json                 # 去重 / 学科 / 视频索引
    ├── notes/<bvid>.md            # 视频笔记 Markdown 源 + meta.json
    ├── manuals/<学科>.md          # 学科手册 Markdown 源
    └── logs/course.log            # JSONL 日志（2MB 轮转）
```

Word 包含：封面、元信息表、目录（手册/总览）、学习目标、核心知识点（8~20 条）、
关键概念、弹幕与评论区洞察、思维导图（mermaid mindmap → 原生分级大纲）、复习清单、
内容来源与覆盖度、页脚页码、B 站超链接。

## 新会话交付

生成 Word 后，插件通过 host `agents` 服务创建一个标准 DSH 会话（cwd=工作区），
挂载 `standard` preset，命名 `📚 <学科>｜<标题>`，并发送一条指令：

1. 必须调用 `present` 交付视频笔记 + 学科手册；
2. 若 `memory` 工具可用，用 `target=key` / `target=project` 写入项目记忆；
3. 用 5 条以内要点回复。

60s 内没有看到 `deliverables/presented` 事件时，会自动再提醒一次 present；仍失败
则记录在 `course_map_status`，可调用 `course_map_deliver` 重试。

> “对话框”指 DSH 会话中的交付卡片（可点击打开 Word），不是预填输入框附件——
> DSH 没有给助手预填草稿附件的接口。

## 工具

| 工具 | 作用 |
| --- | --- |
| `course_map_status` | 启用状态、输出目录、检测后端、前台应用、学科/视频数、最近交付、最近错误 |
| `course_map_scan` | 立即检测当前视频，或传 `title`/`url`；`force` 强制重做 |
| `course_map_deliver` | 把最近/指定视频的 Word 重新交付到新会话 |
| `course_map_rebuild` | 从 Markdown 源重建学科手册/总览 Word |

## 配置

优先级：`DEFAULTS` < `<pluginDir>/config.json` < Cordis 行 config。

```json
{
  "enabled": true,
  "pollIntervalMs": 15000,
  "stablePolls": 2,
  "outputDir": "/Users/you/Downloads/课程助手/课程知识地图",
  "fetchContent": true,
  "browser": {
    "backend": "auto",
    "tabbitTask": "dsh-course-map",
    "chromeRecencyMinutes": 30,
    "appleScriptEnabled": true
  },
  "delivery": {
    "newSession": true,
    "cwd": "/Users/you/Downloads/课程助手",
    "present": true,
    "memory": true,
    "sessionTitlePrefix": "📚"
  },
  "summary": { "maxDanmaku": 120, "maxComments": 20, "maxDescChars": 1200 }
}
```

## 安装（macOS / DSH Desktop）

```sh
cd /path/to/course-notes
node apps/dsh-video-coursemap/scripts/install.mjs \
  --profile desktop \
  --workspace /path/to/course-notes
```

安装器会：

1. 备份 profile 里的市场版插件与 `cordis.patch.yml` 到 `backups/install-<时间>/`；
2. 用本目录代码覆盖 `~/.dsh/profiles/desktop/node_modules/dsh-video-coursemap/`；
3. 写入安装后的 `config.json`（输出目录、工作区、交付会话）；
4. 把 `dsh-memory-evolve` 的 `disabled: true` 改为 `false`；
5. 生成双击可执行的 `backups/install-<时间>/rollback.command`。

安装后**必须完全退出并重新打开 DeepSeek Harness**（host 插件需要重启加载）。

回滚：

```sh
node apps/dsh-video-coursemap/scripts/install.mjs --rollback backups/install-<时间>
```

## 测试

```sh
cd apps/dsh-video-coursemap
node --test 'tests/*.test.js'
node scripts/e2e.mjs          # 真实 B 站抓取 + 假 LLM + 真实 python-docx
```

## 已知限制

- Chrome 只能按 History 近似判断“当前视频”，无法读取当前标签页；Tabbit 才精确。
- 多数 B 站视频没有机器字幕，AI 总结接口需要登录；总结以简介/分P/标签/弹幕/评论为主，
  并在文档中标注覆盖度。
- 前台窗口不是浏览器/视频客户端时不检测（符合“当前窗口”语义）。
- 新会话交付依赖 host `agents` / `agentPresets` 服务；缺失时只生成 Word，可用
  `course_map_deliver` 或在当前会话 `present`。
- 覆盖市场版安装；从市场更新会覆盖本地增强，重跑安装器即可。

## 归因

原始项目：<https://github.com/linner1224/dsh-video-coursemap>（MIT）。
本版本重写了 macOS 检测、内容抓取、Word 文档、DSH 新会话交付与 memory-evolve 集成，
保留原插件 id 与工具名以便无缝替换。
