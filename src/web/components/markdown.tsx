import { Fragment, type ReactNode } from 'react'

/** 够用的 Markdown 渲染：标题、列表、引用、段落，行内支持粗体、行内代码和链接。 不引解析库也不用 dangerouslySetInnerHTML —— 这段文本来自模型， 直接拼 HTML 就是把注入风险接进来 */
export function Markdown(props: { text: string }) {
  return <div className="space-y-3.5">{blocks(props.text)}</div>
}

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = text.split('\n')
  let bullets: string[] = []
  let paragraph: string[] = []

  const flushBullets = () => {
    if (bullets.length === 0) return
    out.push(
      <ul key={`ul-${out.length}`} className="ml-5 list-disc space-y-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="text-foreground/90 text-[15px] leading-[1.85]">
            {inline(b)}
          </li>
        ))}
      </ul>,
    )
    bullets = []
  }
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(
      <p key={`p-${out.length}`} className="text-foreground/90 text-[15.5px] leading-[1.85]">
        {inline(paragraph.join(' '))}
      </p>,
    )
    paragraph = []
  }
  const flush = () => {
    flushParagraph()
    flushBullets()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flush()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      const level = heading[1]!.length
      const body = inline(heading[2] ?? '')
      out.push(
        level <= 2 ? (
          <h2 key={`h-${out.length}`} className="mt-2 text-[19px] leading-snug font-bold">
            {body}
          </h2>
        ) : (
          <h3 key={`h-${out.length}`} className="mt-1 text-[16px] leading-snug font-semibold">
            {body}
          </h3>
        ),
      )
      continue
    }

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      flushParagraph()
      bullets.push(bullet[1] ?? '')
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flush()
      out.push(
        <p
          key={`q-${out.length}`}
          className="border-brand/40 text-foreground/80 border-l-2 pl-3.5 text-[15px] leading-relaxed"
        >
          {inline(quote[1] ?? '')}
        </p>,
      )
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flush()
      out.push(<hr key={`hr-${out.length}`} className="border-border" />)
      continue
    }

    flushBullets()
    paragraph.push(line.trim())
  }
  flush()
  return out
}

/** `**粗体**`、`` `代码` ``、`[文字](链接)`。三者不嵌套，够读就行。 */
function inline(text: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  const out: ReactNode[] = []
  let last = 0
  let key = 0

  for (const m of text.matchAll(pattern)) {
    const at = m.index
    if (at > last) out.push(<Fragment key={key++}>{text.slice(last, at)}</Fragment>)
    const token = m[0]
    if (token.startsWith('**')) {
      out.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      )
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key++} className="bg-muted rounded px-1 py-0.5 font-mono text-[13.5px]">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? token
      out.push(
        <a
          key={key++}
          href={m[2]}
          target="_blank"
          rel="noreferrer"
          className="text-brand-ink hover:underline"
        >
          {label}
        </a>,
      )
    }
    last = at + token.length
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>)
  return out
}
