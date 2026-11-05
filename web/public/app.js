(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const state = { result: null, tab: 'summary' }

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function inline(text) {
    let value = esc(text)
    value = value.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    return value
  }

  function stripMermaid(markdown) {
    return String(markdown || '').replace(/\`\`\`mermaid[\s\S]*?\`\`\`/g, '')
  }

  function extractMindmaps(markdown) {
    const blocks = []
    const re = /\`\`\`mermaid([\s\S]*?)\`\`\`/g
    let match
    while ((match = re.exec(String(markdown || ''))) !== null) {
      const body = match[1] || ''
      if (!/^\s*mindmap\b/im.test(body)) continue
      blocks.push(body.split('\n'))
    }
    return blocks
  }

  function renderMindmap(lines) {
    const nodes = []
    for (const raw of lines) {
      if (!raw.trim() || /^\s*mindmap\b/i.test(raw)) continue
      const indent = raw.length - raw.replace(/^\s+/, '').length
      let text = raw.trim().replace(/^root\s*/, '')
      for (let pass = 0; pass < 3; pass += 1) {
        if (/^\(\(.*\)\)$/.test(text)) text = text.slice(2, -2)
        else if (/^\[.*\]$/.test(text)) text = text.slice(1, -1)
        else if (/^\(.*\)$/.test(text)) text = text.slice(1, -1)
        else if (/^\{.*\}$/.test(text)) text = text.slice(1, -1)
        else break
      }
      text = text.trim()
      if (text) nodes.push({ indent, text })
    }
    if (!nodes.length) return ''
    const minIndent = Math.min(...nodes.map((node) => node.indent))
    let html = '<div class="mindmap"><div class="mindmap-root">' + esc(nodes[0].text) + '</div><ul class="mindmap-list">'
    for (let i = 1; i < nodes.length; i += 1) {
      const level = Math.max(1, Math.min(4, Math.round((nodes[i].indent - minIndent) / 2)))
      html += '<li class="mindmap-node lvl-' + level + '">' + esc(nodes[i].text) + '</li>'
    }
    return html + '</ul></div>'
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
    const html = []
    let list = false
    let inCode = false
    let codeLang = ''
    let code = []
    const closeList = () => { if (list) { html.push('</ul>'); list = false } }
    for (const raw of lines) {
      if (/^\`\`\`/.test(raw)) {
        if (!inCode) {
          closeList()
          inCode = true
          codeLang = raw.slice(3).trim()
          code = []
        } else {
          inCode = false
          html.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>')
          codeLang = ''
        }
        continue
      }
      if (inCode) { code.push(raw); continue }
      if (!raw.trim()) { closeList(); continue }
      const heading = /^(#{1,4})\s+(.*)$/.exec(raw)
      if (heading) {
        closeList()
        html.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>')
        continue
      }
      if (/^---+$/.test(raw.trim())) { closeList(); html.push('<hr>'); continue }
      const quote = /^>\s?(.*)$/.exec(raw)
      if (quote) { closeList(); html.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); continue }
      const item = /^\s*[-*]\s+(.*)$/.exec(raw)
      if (item) {
        if (!list) { html.push('<ul>'); list = true }
        html.push('<li>' + inline(item[1]) + '</li>')
        continue
      }
      const ordered = /^\s*\d+\.\s+(.*)$/.exec(raw)
      if (ordered) {
        if (!list) { html.push('<ul>'); list = true }
        html.push('<li>' + inline(ordered[1]) + '</li>')
        continue
      }
      closeList()
      html.push('<p>' + inline(raw) + '</p>')
    }
    closeList()
    if (inCode) html.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>')
    return html.join('')
  }

  function setProgress(active, text, sub) {
    $('progress').hidden = false
    $('progressTitle').textContent = text || '正在处理'
    $('progressSub').textContent = sub || ''
    document.querySelectorAll('.steps span').forEach((node) => {
      const step = node.getAttribute('data-step')
      node.className = ''
      if (step === active) node.className = 'active'
      if (['fetch', 'classify', 'summarize', 'done'].indexOf(step) < ['fetch', 'classify', 'summarize', 'done'].indexOf(active)) node.className = 'done'
    })
  }

  function showError(message) {
    $('progress').hidden = true
    $('result').hidden = true
    $('error').hidden = false
    $('errorText').textContent = message
  }

  function renderResult(result) {
    state.result = result
    $('progress').hidden = true
    $('error').hidden = true
    $('result').hidden = false
    $('mode').textContent = result.mode === 'llm' ? 'LLM 总结' : '本地提取'
    $('title').textContent = result.title || '知识笔记'
    const meta = []
    if (result.subject) meta.push('学科：' + result.subject)
    if (result.keywords && result.keywords.length) meta.push(result.keywords.slice(0, 8).join(' · '))
    if (result.coverage) meta.push('覆盖：' + result.coverage)
    $('meta').textContent = meta.join('  |  ')
    $('warning').hidden = !result.warning
    $('warning').textContent = result.warning || ''
    renderTab()
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function renderTab() {
    if (!state.result) return
    document.querySelectorAll('#tabs button').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-tab') === state.tab)
    })
    if (state.tab === 'mindmap') {
      const blocks = extractMindmaps(state.result.markdown)
      $('markdownBody').innerHTML = blocks.length
        ? blocks.map((lines) => renderMindmap(lines)).join('')
        : '<p class="source">本次笔记没有思维导图。</p>'
    } else {
      $('markdownBody').innerHTML = renderMarkdown(stripMermaid(state.result.markdown))
    }
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const url = $('url').value.trim()
    if (!url) return showError('请先粘贴 B 站视频链接')
    const key = $('key').value.trim()
    $('submit').disabled = true
    $('error').hidden = true
    $('result').hidden = true
    setProgress('fetch', '正在抓取视频信息', '读取简介、分P、标签、弹幕与评论…')
    setTimeout(() => setProgress('classify', '正在判断学科', '整理关键词与学习主题…'), 1200)
    setTimeout(() => setProgress('summarize', '正在生成知识笔记', '这通常需要 10–30 秒…'), 2600)
    try {
      const response = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apiKey: key }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || '生成失败，请稍后再试')
      $('key').value = ''
      setProgress('done', '完成', '笔记已生成')
      renderResult(data)
    } catch (error) {
      showError(String(error.message || error))
    } finally {
      $('submit').disabled = false
    }
  })

  $('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]')
    if (!button) return
    state.tab = button.getAttribute('data-tab')
    renderTab()
  })

  $('copy').addEventListener('click', async () => {
    if (!state.result) return
    try { await navigator.clipboard.writeText(state.result.markdown); $('copy').textContent = '已复制' ; setTimeout(() => { $('copy').textContent = '复制 Markdown' }, 1200) } catch { /* ignore */ }
  })

  $('markdown').addEventListener('click', () => {
    if (!state.result) return
    download((state.result.title || 'course-notes') + '.md', state.result.markdown, 'text/markdown;charset=utf-8')
  })

  $('docx').addEventListener('click', async () => {
    if (!state.result) return
    $('docx').disabled = true
    $('docx').textContent = '生成中…'
    try {
      const response = await fetch('/api/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: state.result.markdown, title: state.result.title }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Word 生成失败')
      }
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = (state.result.title || 'course-notes') + '.docx'
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    } catch (error) {
      showError(String(error.message || error))
    } finally {
      $('docx').disabled = false
      $('docx').textContent = '下载 Word'
    }
  })
})();
