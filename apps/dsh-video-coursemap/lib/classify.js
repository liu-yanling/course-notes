/**
 * dsh-video-coursemap — course detection and subject classification.
 * @module dsh-video-coursemap/classify
 */

import { parseJson, sanitizeSubject, stripHtml, uniqueStrings } from './util.js'
import { callLlm, userMessage } from './llm.js'
import { matchSubject } from './state.js'

const NEGATIVE = [
  /纯音乐|音乐合集|歌单|MV|翻唱|演奏|钢琴曲/i,
  /鬼畜|搞笑|沙雕|段子|整活|名场面/i,
  /直播回放|直播录播|聊天|连麦/i,
  /新闻联播|时政|发布会|发布会全程/i,
  /游戏实况|通关|速通|抽卡|开箱|上分/i,
  /影视解说|电影解说|电视剧|综艺|追剧/i,
  /颜值|舞蹈|美妆|穿搭|vlog|日常/i,
]

const POSITIVE = [
  /课程|教程|教学|讲解|入门|精通|进阶|学习|培训|公开课|网课|训练营/i,
  /原理|科普|知识|干货|详解|拆解|分析|总结|方法论|思维模型/i,
  /实战|项目|案例|面试|题库|考试|考研|复习|笔记/i,
  /算法|编程|代码|开发|前端|后端|数据库|架构|运维|安全/i,
  /机器学习|深度学习|人工智能|神经网络|大模型|LLM|AI/i,
  /数学|高数|线代|概率|统计|物理|化学|生物|经济|金融|历史|哲学|英语|雅思|托福/i,
]

const SUBJECT_RULES = [
  [/机器学习|深度学习|神经网络|人工智能|大模型|LLM|AIGC|提示词|transformer|pytorch|tensorflow|吴恩达/i, '人工智能'],
  [/前端|react|vue|javascript|typescript|css|html|浏览器|小程序|next\.js|vite/i, '前端开发'],
  [/后端|java|spring|go语言|golang|python后端|node\.js|数据库|mysql|redis|微服务|架构|docker|k8s|kubernetes/i, '后端开发'],
  [/算法|数据结构|leetcode|刷题|动态规划|图论/i, '算法与数据结构'],
  [/高数|高等数学|线性代数|概率论|微积分|数学分析/i, '数学'],
  [/英语|雅思|托福|四六级|单词|语法|口语/i, '英语'],
  [/历史|中国古代史|世界史|近代史/i, '历史'],
  [/哲学|康德|黑格尔|存在主义|伦理学/i, '哲学'],
  [/经济|金融|投资|理财|宏观经济|微观经济/i, '经济金融'],
  [/物理|量子|相对论|力学|电磁学/i, '物理'],
  [/产品经理|产品设计|需求分析|用户研究|增长/i, '产品'],
  [/运营|新媒体|短视频|流量|私域/i, '运营'],
  [/摄影|剪辑|调色|pr|final cut|达芬奇/i, '影像创作'],
  [/美食|烹饪|烘焙|探店/i, '美食'],
  [/健身|运动|跑步|力量训练/i, '健身'],
]

/** Deterministic fallback when the LLM is unavailable or returns garbage. */
export function fallbackClassify(title, hints = {}) {
  const text = [
    String(title ?? ''),
    ...(Array.isArray(hints.tags) ? hints.tags : []),
    String(hints.desc ?? ''),
  ].join(' ')
  const negative = NEGATIVE.some((re) => re.test(text))
  const positive = POSITIVE.some((re) => re.test(text))
  const subjectRule = SUBJECT_RULES.find(([re]) => re.test(text))
  const keywords = uniqueStrings(
    [
      ...(Array.isArray(hints.tags) ? hints.tags : []),
      ...String(title ?? '')
        .split(/[\s,，、|｜:：\-—/]+/)
        .filter((part) => part.length >= 2 && part.length <= 12),
    ],
    6,
  )
  const isCourse = positive && (!negative || /教程|课程|讲解|入门|学习|原理|实战/i.test(text))
  return {
    isCourse,
    subject: subjectRule?.[1] ?? (isCourse ? '通识' : '未分类'),
    title: String(title ?? '').trim(),
    keywords,
    confidence: subjectRule ? 0.55 : 0.35,
    reason: subjectRule
      ? `关键词规则命中：${subjectRule[1]}`
      : isCourse
        ? '标题包含知识类信号'
        : '未命中知识类信号',
    fallback: true,
  }
}

export function buildClassifyPrompt(title, existingSubjects, hints = {}) {
  const system = '你是视频内容分类助手。判断一个浏览器当前标题是否值得整理成知识地图，并归类到学科。'
  const hintLines = []
  if (hints.tags?.length) hintLines.push(`标签：${hints.tags.join('、')}`)
  if (hints.desc) hintLines.push(`简介：${String(hints.desc).slice(0, 600)}`)
  if (hints.chapters?.length) {
    hintLines.push(`分P：${hints.chapters.slice(0, 12).join(' / ')}`)
  }
  const user = `浏览器当前标题：${JSON.stringify(String(title ?? ''))}
已有学科列表：${JSON.stringify(existingSubjects ?? [])}
${hintLines.length ? hintLines.join('\n') + '\n' : ''}
只返回一个合法 JSON 对象（不要任何多余文字、不要 markdown 代码块、不要尾逗号），格式：
{"isCourse":true,"subject":"学科名","title":"清洗后的视频标题","keywords":["关键词1","关键词2"],"confidence":0.9,"reason":"一句话理由"}

规则：
- isCourse=true：课程、教程、教学、科普、纪录片、开箱测评、知识分享、技能讲解、历史/文化/科技解读等有知识含量的内容。
- isCourse=false：纯音乐、搞笑段子、无解说游戏实况、直播聊天、新闻播报、普通网页、搜索页、社交页、邮箱、工作软件、纯影视解说/综艺等。
- 若该视频属于已有学科之一，subject 必须与列表里某个已有名字完全一致；否则给一个简洁的新学科名（中文，≤8 字，如 机器学习/前端开发/英语/历史/数学/算法/美食测评）。
- title 为去掉浏览器与平台后缀后的纯视频标题。
- keywords 为 3~6 个核心知识点关键词。
- confidence 为 0~1 的数字。`
  return { system, user }
}

function normalizeClassify(raw, title, existingSubjects) {
  if (!raw || typeof raw !== 'object') return null
  const isCourse = raw.isCourse === true
  const subjectRaw = String(raw.subject ?? '').trim() || (isCourse ? '未分类' : '未分类')
  const matched = isCourse ? matchSubject(subjectRaw, existingSubjects) : null
  const subject = isCourse ? sanitizeSubject(matched ?? subjectRaw) : '未分类'
  const keywords = uniqueStrings(
    Array.isArray(raw.keywords) ? raw.keywords.map(String) : [],
    10,
  )
  return {
    isCourse,
    subject,
    title: String(raw.title ?? title ?? '').trim() || String(title ?? '').trim(),
    keywords,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.5,
    reason: String(raw.reason ?? '').slice(0, 300),
    fallback: false,
  }
}

/**
 * Classify one browser title.
 * @param {object} ctx plugin context
 * @param {object} config resolved config
 * @param {{title: string, hints?: object}} input
 */
export async function classify(ctx, config, input) {
  const title = String(input?.title ?? '').trim()
  const existing = Object.keys(input?.existingSubjects ?? {})
  const hints = input?.hints ?? {}
  const prompt = buildClassifyPrompt(title, existing, hints)
  let text = ''
  let parsed = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      text = await callLlm(ctx, config, {
        system: prompt.system,
        messages: [userMessage(prompt.user)],
        maxTokens: 700,
        timeoutMs: 60000,
      })
      parsed = parseJson(text)
      if (parsed) break
    } catch {
      /* retry once, then fall back */
    }
  }
  const normalized = normalizeClassify(parsed, title, input?.existingSubjects ?? {})
  if (normalized) return normalized
  return fallbackClassify(title, hints)
}

/** Extract simple keywords from a video title without an LLM. */
export function titleKeywords(title) {
  return uniqueStrings(
    String(title ?? '')
      .split(/[\s,，、|｜:：\-—/【】\[\]()（）]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && part.length <= 16),
    8,
  )
}
