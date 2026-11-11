/**
 * 写 OOXML（.docx / .pptx）共用的两个转义函数。
 *
 * 合成一处是因为它是**文件能不能打开**的分界线，而不是排版细节：
 * 正文里一个没转义的 `&`、一个从模型那里带出来的 `\u0000`，
 * Word 和 PowerPoint 的反应都是"文件已损坏"——而且报错不会指向那个字符。
 */

/** XML 里必须转义的五个字符 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * XML 1.0 不允许出现的控制字符（`\t` `\n` `\r` 除外）。
 * 它们原样写进去会让整份文件打不开，所以是**删掉**而不是转义——转义成实体也不合法。
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** 直接可用的正文文本：先清控制字符，再转义 */
export function textXml(text: string): string {
  return escapeXml(stripControlChars(text))
}
