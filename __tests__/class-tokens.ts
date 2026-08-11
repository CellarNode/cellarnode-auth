export function classTokensAt(
  html: string,
  elementIndex: number,
): readonly string[] {
  const classAttribute = Array.from(html.matchAll(/class="([^"]*)"/g))[
    elementIndex
  ]?.[1];

  return classAttribute?.split(/\s+/).filter(Boolean) ?? [];
}
