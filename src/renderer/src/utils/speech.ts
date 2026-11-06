/**
 * 播报：只读结论，不含正文。
 *
 * 口径（用户拍板）：朗读稿 = 结论句。回答是结论先行的，所以取第一段、
 * 剥掉 Markdown 标记、截到 120 字；不会把整篇回答读出来。
 * 触发：气泡上的「播结论」按钮（明确需要时点一下），或打开了
 * 输入框旁的播报开关（用户显式开启 = 明确需要），默认关、不会主动出声。
 * 用系统 speechSynthesis，不引依赖、不经网络。
 */

const MAX_LEN = 120

/** 从回答里剥出结论句：第一段 + 去 Markdown + 截断 */
export function conclusionOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*•]\s*/gm, '')
    .replace(/[*_>]+/g, '')
  const firstPara =
    plain
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? ''
  // 结论先行的回答第一段经常不止一句：按句号收，到 120 字为止，宁可短不可啰嗦
  const sentences = firstPara.split(/(?<=[。！？!?；;])/).filter(Boolean)
  let out = ''
  for (const sentence of sentences) {
    if (out.length + sentence.length > MAX_LEN && out) break
    out += sentence
    if (out.length >= MAX_LEN) break
  }
  return (out || firstPara.slice(0, MAX_LEN)).replace(/\s+/g, ' ').trim()
}

export function speak(text: string): void {
  if (!('speechSynthesis' in window) || !text.trim()) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.rate = 1.05
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}
