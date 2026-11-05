#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""md2docx.py <in.md> <out.docx> [meta.json]

把受控 Markdown 转成 Word 文档（.docx）。

支持：封面、元信息表、目录（H2）、标题 #/##/###/####、无序列表 -（含缩进层级）、
有序列表 1.、checkbox、引用 >、表格 | |、代码围栏、**加粗** / *斜体* / 行内代码、
Markdown 链接 [文字](url)、--- 分隔线、HTML 注释。

特别地：mermaid mindmap 代码块会被解析成原生 Word 分级大纲
（根节点加粗 + 子节点分级项目符号），使「知识地图」在 Word 里呈现为真正的
层级结构，而不是原始代码文本。

依赖：python-docx（DSH 自带 Python 3.12 已包含）。
"""

import json
import re
import sys
from datetime import datetime

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_FONT = 'Calibri'
EAST_ASIA_FONT = '宋体'
HEADING_FONT = '微软雅黑'
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
MUTED = RGBColor(0x66, 0x66, 0x66)
CODE_FONT = 'Consolas'
FENCE = '\x60' * 3
TICK = '\x60'

_INLINE_RE = re.compile(
    r'(\*\*[^*]+\*\*|\*[^*]+\*|' + TICK + r'[^' + TICK + r']+' + TICK + r'|\[[^\]]+\]\([^)]+\))'
)
_CHECK_RE = re.compile(r'^\s*[-*]\s+\[[ xX]\]\s+')


def _set_east_asia(run, font=EAST_ASIA_FONT):
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.get_or_add_rFonts()
    rfonts.set(qn('w:eastAsia'), font)


def _set_style_east_asia(style, font=EAST_ASIA_FONT):
    rpr = style.element.get_or_add_rPr()
    rpr.get_or_add_rFonts().set(qn('w:eastAsia'), font)


def add_hyperlink(paragraph, url, text, color='1F4E79'):
    """Insert a real clickable hyperlink into a paragraph."""
    part = paragraph.part
    r_id = part.relate_to(
        url,
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
        is_external=True,
    )
    hyperlink = OxmlElement('w:hyperlink')
    hyperlink.set(qn('r:id'), r_id)
    new_run = OxmlElement('w:r')
    r_pr = OxmlElement('w:rPr')
    color_el = OxmlElement('w:color')
    color_el.set(qn('w:val'), color)
    r_pr.append(color_el)
    u_el = OxmlElement('w:u')
    u_el.set(qn('w:val'), 'single')
    r_pr.append(u_el)
    new_run.append(r_pr)
    text_el = OxmlElement('w:t')
    text_el.text = text
    new_run.append(text_el)
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)


def add_inline(paragraph, text):
    """Parse bold / italic / inline code / Markdown links."""
    position = 0
    for match in _INLINE_RE.finditer(text):
        if match.start() > position:
            paragraph.add_run(text[position : match.start()])
        token = match.group(0)
        if token.startswith('**') and token.endswith('**') and len(token) >= 4:
            run = paragraph.add_run(token[2:-2])
            run.bold = True
        elif token.startswith('*') and token.endswith('*') and len(token) >= 2:
            run = paragraph.add_run(token[1:-1])
            run.italic = True
        elif token.startswith(TICK) and token.endswith(TICK) and len(token) >= 2:
            run = paragraph.add_run(token[1:-1])
            run.font.name = CODE_FONT
            run.font.size = Pt(9.5)
        elif token.startswith('['):
            link = re.match(r'\[([^\]]+)\]\(([^)]+)\)', token)
            if link:
                add_hyperlink(paragraph, link.group(2), link.group(1))
            else:
                paragraph.add_run(token)
        position = match.end()
    if position < len(text):
        paragraph.add_run(text[position:])


def _mindmap_text(text):
    t = text.strip()
    t = re.sub(r'^root\s*', '', t)
    for _ in range(3):
        if t.startswith('((') and t.endswith('))'):
            t = t[2:-2].strip()
        elif t.startswith('[') and t.endswith(']'):
            t = t[1:-1].strip()
        elif t.startswith('(') and t.endswith(')'):
            t = t[1:-1].strip()
        elif t.startswith('{') and t.endswith('}'):
            t = t[1:-1].strip()
        elif t.startswith('))') and t.endswith('(('):
            t = t[2:-2].strip()
        else:
            break
    return t.strip()


def _is_mindmap(code_lines):
    first = next((line.strip() for line in code_lines if line.strip()), '')
    return first.lower().startswith('mindmap')


def _render_mindmap(doc, code_lines):
    nodes = []
    for line in code_lines:
        stripped = line.rstrip()
        if not stripped.strip():
            continue
        if stripped.strip().lower() == 'mindmap':
            continue
        indent = len(stripped) - len(stripped.lstrip(' '))
        text = _mindmap_text(stripped)
        if text:
            nodes.append((indent, text))
    if not nodes:
        return
    root_indent = min(indent for indent, _ in nodes)
    root_index = next(index for index, (indent, _) in enumerate(nodes) if indent == root_indent)
    paragraph = doc.add_paragraph()
    run = paragraph.add_run(nodes[root_index][1])
    run.bold = True
    run.font.size = Pt(12)
    rest = [(indent, text) for index, (indent, text) in enumerate(nodes) if index != root_index]
    if not rest:
        return
    indents = sorted({indent for indent, _ in rest})
    indent_to_level = {indent: min(index, 2) for index, indent in enumerate(indents)}
    styles = ['List Bullet', 'List Bullet 2', 'List Bullet 3']
    for indent, text in rest:
        paragraph = doc.add_paragraph(style=styles[indent_to_level[indent]])
        add_inline(paragraph, text)


def _add_table(doc, rows):
    if not rows:
        return
    width = max(len(row) for row in rows)
    table = doc.add_table(rows=len(rows), cols=width)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for row_index, row in enumerate(rows):
        for col_index in range(width):
            cell = table.cell(row_index, col_index)
            cell.text = ''
            paragraph = cell.paragraphs[0]
            value = row[col_index] if col_index < len(row) else ''
            add_inline(paragraph, value)
            if row_index == 0:
                for run in paragraph.runs:
                    run.bold = True
    doc.add_paragraph()


def _add_metadata_table(doc, meta):
    entries = []
    for key, label in [
        ('subject', '学科'),
        ('owner', 'UP 主'),
        ('date', '日期'),
        ('coverage', '内容覆盖'),
        ('duration', '时长'),
    ]:
        value = meta.get(key)
        if value:
            if key == 'duration' and isinstance(value, (int, float)) and value > 0:
                value = f'{int(value) // 60} 分 {int(value) % 60} 秒'
            entries.append((label, str(value)))
    if meta.get('bvid'):
        entries.append(('BV 号', str(meta['bvid'])))
    if meta.get('url'):
        entries.append(('视频链接', str(meta['url'])))
    if meta.get('keywords'):
        entries.append(('关键词', '、'.join(meta['keywords'])))
    stats = meta.get('stats') or {}
    labels = [
        ('view', '播放'),
        ('like', '点赞'),
        ('coin', '投币'),
        ('favorite', '收藏'),
        ('reply', '评论'),
        ('danmaku', '弹幕'),
    ]
    stat_text = ' · '.join(f'{label} {stats.get(key, 0)}' for key, label in labels if stats.get(key))
    if stat_text:
        entries.append(('数据', stat_text))
    if not entries:
        return
    table = doc.add_table(rows=len(entries), cols=2)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for index, (label, value) in enumerate(entries):
        left = table.cell(index, 0)
        right = table.cell(index, 1)
        left.text = ''
        right.text = ''
        left_para = left.paragraphs[0]
        right_para = right.paragraphs[0]
        run = left_para.add_run(label)
        run.bold = True
        run.font.size = Pt(9.5)
        run.font.color.rgb = MUTED
        if label == '视频链接':
            add_hyperlink(right_para, value, value)
        else:
            run = right_para.add_run(value)
            run.font.size = Pt(9.5)
    doc.add_paragraph()


def _add_cover(doc, meta):
    for _ in range(4):
        doc.add_paragraph()
    title = meta.get('title') or '视频课程知识地图'
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run(title)
    run.bold = True
    run.font.size = Pt(26)
    run.font.color.rgb = ACCENT
    _set_east_asia(run, HEADING_FONT)

    subtitle = meta.get('subtitle') or ''
    if not subtitle:
        parts = []
        if meta.get('subject'):
            parts.append(str(meta['subject']))
        if meta.get('owner'):
            parts.append(f"UP：{meta['owner']}")
        if meta.get('date'):
            parts.append(str(meta['date']))
        subtitle = ' ｜ '.join(parts)
    if subtitle:
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = paragraph.add_run(subtitle)
        run.font.size = Pt(13)
        run.font.color.rgb = MUTED

    doc.add_paragraph()
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    kind_label = {'video': '视频知识笔记', 'manual': '学科学习手册', 'overview': '课程总览'}.get(
        meta.get('kind', ''), '知识笔记'
    )
    run = paragraph.add_run(kind_label)
    run.font.size = Pt(12)
    run.font.color.rgb = MUTED

    for _ in range(8):
        doc.add_paragraph()
    generated = meta.get('generatedAt') or datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run(f'由课程助手自动生成 · {generated}')
    run.font.size = Pt(9)
    run.font.color.rgb = MUTED
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def _add_toc(doc, lines):
    headings = [line.strip()[3:].strip() for line in lines if line.strip().startswith('## ')]
    if len(headings) < 2:
        return
    heading = doc.add_heading('目录', level=1)
    _style_heading(heading, 1)
    for text in headings[:30]:
        paragraph = doc.add_paragraph(style='List Bullet')
        add_inline(paragraph, text)
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def _style_heading(heading, level):
    sizes = {1: 20, 2: 15, 3: 12.5, 4: 11.5}
    for run in heading.runs:
        run.font.size = Pt(sizes.get(level, 11.5))
        run.font.color.rgb = ACCENT
        run.bold = True
        _set_east_asia(run, HEADING_FONT)
    heading.paragraph_format.space_before = Pt(14 if level <= 2 else 8)
    heading.paragraph_format.space_after = Pt(6)


def _add_footer(section):
    footer = section.footer
    paragraph = footer.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run('第 ')
    run.font.size = Pt(9)
    run.font.color.rgb = MUTED
    fld_char_begin = OxmlElement('w:fldChar')
    fld_char_begin.set(qn('w:fldCharType'), 'begin')
    instr_text = OxmlElement('w:instrText')
    instr_text.set(qn('xml:space'), 'preserve')
    instr_text.text = 'PAGE'
    fld_char_end = OxmlElement('w:fldChar')
    fld_char_end.set(qn('w:fldCharType'), 'end')
    run._r.append(fld_char_begin)
    run._r.append(instr_text)
    run._r.append(fld_char_end)
    run = paragraph.add_run(' 页')
    run.font.size = Pt(9)
    run.font.color.rgb = MUTED


def _add_header(section, text='课程助手 · 视频知识地图'):
    header = section.header
    paragraph = header.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run(text)
    run.font.size = Pt(9)
    run.font.color.rgb = MUTED


def _setup_document(meta):
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.2)
    _add_header(section)
    _add_footer(section)

    normal = doc.styles['Normal']
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    _set_style_east_asia(normal)
    normal.paragraph_format.line_spacing = 1.35
    normal.paragraph_format.space_after = Pt(4)

    for name, size in [
        ('Heading 1', 20),
        ('Heading 2', 15),
        ('Heading 3', 12.5),
        ('Heading 4', 11.5),
    ]:
        try:
            style = doc.styles[name]
            style.font.name = BODY_FONT
            style.font.size = Pt(size)
            style.font.bold = True
            style.font.color.rgb = ACCENT
            _set_style_east_asia(style, HEADING_FONT)
        except KeyError:
            pass

    props = doc.core_properties
    props.title = str(meta.get('title') or '视频课程知识地图')
    props.subject = str(meta.get('subject') or '')
    props.author = '课程助手'
    props.comments = '由 dsh-video-coursemap 自动生成'
    return doc


def convert(md_path, docx_path, meta_path=None):
    with open(md_path, 'r', encoding='utf-8') as handle:
        lines = handle.read().replace('\r\n', '\n').split('\n')
    meta = {}
    if meta_path:
        try:
            with open(meta_path, 'r', encoding='utf-8') as handle:
                meta = json.load(handle)
        except Exception:
            meta = {}

    doc = _setup_document(meta)
    _add_cover(doc, meta)
    if meta.get('kind') in ('manual', 'overview'):
        _add_toc(doc, lines)
    elif meta.get('kind') == 'video':
        _add_metadata_table(doc, meta)

    index = 0
    in_code = False
    code_lines = []
    table_rows = []

    def flush_code():
        nonlocal in_code, code_lines
        if not code_lines:
            in_code = False
            return
        if _is_mindmap(code_lines):
            _render_mindmap(doc, code_lines)
        else:
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Pt(16)
            for line_index, code_line in enumerate(code_lines):
                run = paragraph.add_run(('\n' if line_index else '') + code_line)
                run.font.name = CODE_FONT
                run.font.size = Pt(9)
                run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
        in_code = False
        code_lines = []

    def flush_table():
        nonlocal table_rows
        if table_rows:
            _add_table(doc, table_rows)
            table_rows = []

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith(FENCE):
            if in_code:
                flush_code()
            else:
                flush_table()
                in_code = True
                code_lines = []
            index += 1
            continue

        if in_code:
            code_lines.append(line)
            index += 1
            continue

        if stripped.startswith('|') and stripped.endswith('|'):
            cells = [cell.strip() for cell in stripped.strip('|').split('|')]
            if not all(re.fullmatch(r':?-{2,}:?', cell) for cell in cells):
                table_rows.append(cells)
            index += 1
            continue
        flush_table()

        if stripped == '' or stripped == '---':
            index += 1
            continue
        if stripped.startswith('<!--') and stripped.endswith('-->'):
            index += 1
            continue

        if stripped.startswith('#### '):
            heading = doc.add_heading('', level=4)
            add_inline(heading, stripped[5:])
            _style_heading(heading, 4)
        elif stripped.startswith('### '):
            heading = doc.add_heading('', level=3)
            add_inline(heading, stripped[4:])
            _style_heading(heading, 3)
        elif stripped.startswith('## '):
            heading = doc.add_heading('', level=2)
            add_inline(heading, stripped[3:])
            _style_heading(heading, 2)
        elif stripped.startswith('# '):
            heading = doc.add_heading('', level=1)
            add_inline(heading, stripped[2:])
            _style_heading(heading, 1)
        elif _CHECK_RE.match(line):
            paragraph = doc.add_paragraph(style='List Bullet')
            text = _CHECK_RE.sub('', line)
            add_inline(paragraph, '☐ ' + text)
        elif re.match(r'^\s*[-*]\s+', line):
            indent = len(line) - len(line.lstrip(' '))
            level = min(indent // 2 + 1, 3)
            style = (
                'List Bullet'
                if level == 1
                else ('List Bullet 2' if level == 2 else 'List Bullet 3')
            )
            paragraph = doc.add_paragraph(style=style)
            add_inline(paragraph, re.sub(r'^\s*[-*]\s+', '', line))
        elif re.match(r'^\s*\d+[.)]\s+', line):
            paragraph = doc.add_paragraph(style='List Number')
            add_inline(paragraph, re.sub(r'^\s*\d+[.)]\s+', '', line))
        elif stripped.startswith('> '):
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.6)
            run = paragraph.add_run(stripped[2:])
            run.italic = True
            run.font.color.rgb = MUTED
            _set_east_asia(run)
        else:
            paragraph = doc.add_paragraph()
            add_inline(paragraph, stripped)
        index += 1

    if in_code:
        flush_code()
    flush_table()
    doc.save(docx_path)
    print('OK', docx_path)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('usage: md2docx.py <in.md> <out.docx> [meta.json]', file=sys.stderr)
        sys.exit(2)
    convert(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
